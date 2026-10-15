// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A software WebAuthn authenticator for tests: produces real "none"
 * attestations and ES256 assertions that @simplewebauthn/server verifies end
 * to end, so the auth flow is tested without mocking the library.
 */
import { randomBytes, toBase64Url } from '../src/core/crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor) => {
    if (typeof x === 'number') out.push(...(x >= 0 ? cborHead(0, x) : cborHead(1, -1 - x)));
    else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x);
      out.push(...cborHead(3, b.length), ...b);
    } else if (x instanceof Uint8Array) out.push(...cborHead(2, x.length), ...x);
    else if (Array.isArray(x)) {
      out.push(...cborHead(4, x.length));
      x.forEach(enc);
    } else {
      out.push(...cborHead(5, x.size));
      for (const [k, val] of x) {
        enc(k);
        enc(val);
      }
    }
  };
  enc(v);
  return new Uint8Array(out);
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));
const u32 = (n: number) =>
  new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

/** WebCrypto gives ECDSA signatures as r||s; WebAuthn wants ASN.1 DER. */
function rawToDer(sig: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(sig.slice(0, 32)), int(sig.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const b64urlJson = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
const decodeChallenge = (options: Record<string, unknown>) => String(options.challenge);

export class SoftAuthenticator {
  credentialId = randomBytes(16);
  counter = 0;
  private keys!: CryptoKeyPair;
  userHandle: string | null = null;

  constructor(
    private rpId: string,
    private origin: string,
  ) {}

  get id() {
    return toBase64Url(this.credentialId);
  }

  async init() {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return this;
  }

  async register(options: Record<string, unknown>, opts: { origin?: string } = {}) {
    const user = options.user as { id: string } | undefined;
    this.userHandle = user?.id ?? null;
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const { fromBase64Url } = await import('../src/core/crypto');
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64Url(jwk.x!)],
        [-3, fromBase64Url(jwk.y!)],
      ]),
    );
    const authData = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      new Uint8Array([0x01 | 0x04 | 0x40]), // UP | UV | AT
      u32(this.counter),
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      cose,
    );
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = b64urlJson({
      type: 'webauthn.create',
      challenge: decodeChallenge(options),
      origin: opts.origin ?? this.origin,
      crossOrigin: false,
    });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON,
        attestationObject: toBase64Url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  async assert(options: Record<string, unknown>, opts: { uv?: boolean } = {}) {
    this.counter++;
    const authData = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      new Uint8Array([0x01 | (opts.uv === false ? 0 : 0x04)]),
      u32(this.counter),
    );
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: decodeChallenge(options),
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const signed = concat(authData, await sha256(clientData));
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.keys.privateKey,
        signed as Uint8Array<ArrayBuffer>,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientData),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(rawToDer(sig)),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
