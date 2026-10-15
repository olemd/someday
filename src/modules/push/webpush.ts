// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web Push with WebCrypto only (§8.4) — the `web-push` npm package needs
 * Node crypto, WebCrypto is native everywhere we run.
 *
 * - Payload encryption: RFC 8291 (aes128gcm content coding, RFC 8188), with
 *   ECDH P-256, HKDF-SHA-256 and AES-128-GCM.
 * - Authentication: VAPID (RFC 8292), a JWT signed with ES256.
 */
import { fromBase64Url, toBase64Url } from '../../core/crypto';
import type { PushSender, PushSubscriptionKeys } from '../../core/ports';

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
/** UTF-8 bytes backed by a plain ArrayBuffer (what WebCrypto's types require). */
const u8 = (s: string): Bytes => new Uint8Array(enc.encode(s));

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF (RFC 5869) with a single expand block, enough for ≤ 32 bytes. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  const t1 = await hmac(prk, concat(info, new Uint8Array([1])));
  return t1.slice(0, length);
}

/** Import a P-256 private key from its 32-byte scalar plus the raw public key. */
async function importPrivate(
  d: Bytes,
  publicRaw: Bytes,
  usage: 'ECDH' | 'ECDSA',
): Promise<CryptoKey> {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: toBase64Url(d),
    x: toBase64Url(publicRaw.slice(1, 33)),
    y: toBase64Url(publicRaw.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    usage === 'ECDH'
      ? { name: 'ECDH', namedCurve: 'P-256' }
      : { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    usage === 'ECDH' ? ['deriveBits'] : ['sign'],
  );
}

export interface EncryptOptions {
  /** Test hooks: fixed ephemeral key pair and salt (RFC 8291 Appendix A). */
  asPrivate?: Bytes;
  asPublic?: Bytes;
  salt?: Bytes;
  recordSize?: number;
}

/** RFC 8291 §3.4 / RFC 8188: encrypt one payload into a single aes128gcm record. */
export async function encryptPayload(
  payload: Bytes,
  uaPublic: Bytes,
  authSecret: Bytes,
  opts: EncryptOptions = {},
): Promise<Bytes> {
  let asPublic: Bytes;
  let asPrivateKey: CryptoKey;
  if (opts.asPrivate && opts.asPublic) {
    asPublic = opts.asPublic;
    asPrivateKey = await importPrivate(opts.asPrivate, asPublic, 'ECDH');
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    asPublic = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    );
    asPrivateKey = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    // `public` is the standard EcdhKeyDeriveParams member (and what workerd
    // reads); @cloudflare/workers-types spells it `$public`, hence the cast.
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
      asPrivateKey,
      256,
    ),
  );

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(u8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, u8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, u8('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext followed by the 0x02 "last record" delimiter.
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(payload, new Uint8Array([2])),
    ),
  );

  const rs = opts.recordSize ?? 4096;
  const header = concat(
    salt,
    new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPublic.length]),
    asPublic,
  );
  return concat(header, ciphertext);
}

/** RFC 8292: `vapid t=<JWT>, k=<public key>` for the push service's origin. */
export async function vapidAuthorization(
  endpoint: string,
  keys: { publicKey: string; privateKey: string; subject: string },
  now: number,
): Promise<string> {
  const header = toBase64Url(u8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    u8(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: keys.subject })),
  );
  const signingKey = await importPrivate(
    fromBase64Url(keys.privateKey),
    fromBase64Url(keys.publicKey),
    'ECDSA',
  );
  // WebCrypto ECDSA signatures are r||s (IEEE P1363), exactly what JWS ES256 wants.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      u8(`${header}.${claims}`),
    ),
  );
  return `vapid t=${header}.${claims}.${toBase64Url(sig)}, k=${keys.publicKey}`;
}

export function createPushSender(
  keys: { publicKey: string; privateKey: string; subject: string },
  clock: () => number,
  doFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): PushSender {
  return {
    async send(sub: PushSubscriptionKeys, payload: string, opts = {}) {
      const body = await encryptPayload(
        u8(payload),
        fromBase64Url(sub.p256dh),
        fromBase64Url(sub.auth),
      );
      const res = await doFetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: String(opts.ttl ?? 3600),
          Urgency: opts.urgency ?? 'normal',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: await vapidAuthorization(sub.endpoint, keys, clock()),
        },
        body,
      });
      return res.status;
    },
  };
}
