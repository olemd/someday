// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../src/core/crypto';
import { encryptPayload, vapidAuthorization } from '../src/modules/push/webpush';

// RFC 8291 Appendix A.
const V = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  // Copied from the RFC text (rfc-editor.org/rfc/rfc8291.txt, line 706).
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

describe('RFC 8291 encryption', () => {
  it('reproduces the Appendix A test vector exactly', async () => {
    const out = await encryptPayload(
      fromBase64Url(V.plaintext),
      fromBase64Url(V.uaPublic),
      fromBase64Url(V.auth),
      {
        asPrivate: fromBase64Url(V.asPrivate),
        asPublic: fromBase64Url(V.asPublic),
        salt: fromBase64Url(V.salt),
      },
    );
    const header = fromBase64Url(V.header);
    expect(toBase64Url(out.slice(0, header.length))).toBe(V.header);
    expect(toBase64Url(out.slice(header.length))).toBe(V.ciphertext);
  });

  it('uses a fresh salt and ephemeral key per message', async () => {
    const a = await encryptPayload(
      new Uint8Array([1]),
      fromBase64Url(V.uaPublic),
      fromBase64Url(V.auth),
    );
    const b = await encryptPayload(
      new Uint8Array([1]),
      fromBase64Url(V.uaPublic),
      fromBase64Url(V.auth),
    );
    expect(toBase64Url(a.slice(0, 16))).not.toBe(toBase64Url(b.slice(0, 16)));
  });
});

describe('VAPID', () => {
  it('signs an ES256 JWT for the push service origin that verifies', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicKey = toBase64Url(
      new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    );
    const privateKey = ((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey).d!;
    const auth = await vapidAuthorization(
      'https://push.example.net/send/abc',
      { publicKey, privateKey, subject: 'mailto:a@b.c' },
      1000,
    );
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(m[4]).toBe(publicKey);
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(m[2]!)));
    expect(claims).toEqual({
      aud: 'https://push.example.net',
      exp: 1000 + 12 * 3600,
      sub: 'mailto:a@b.c',
    });
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      fromBase64Url(m[3]!),
      new TextEncoder().encode(`${m[1]}.${m[2]}`),
    );
    expect(ok).toBe(true);
  });
});
