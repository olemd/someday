// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small WebCrypto helpers. WebCrypto is native on Workers, Bun and browsers. */
import { CROCKFORD } from './ulid';

const enc = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

/** `n` random Crockford base32 characters (5 bits each). */
export function randomCrockford(n: number): string {
  let s = '';
  for (const b of randomBytes(n)) s += CROCKFORD[b & 31];
  return s;
}

/**
 * Normalise user-typed Crockford base32: case-insensitive, separators
 * ignored, and the ambiguous letters read as the digits they look like.
 */
export function normalizeCrockford(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

/**
 * Hash for stored bearer secrets (session cookies, invite and link tokens,
 * OAuth tokens): HMAC-SHA-256 with TOKEN_PEPPER, so a leaked database alone
 * cannot be used to check guesses offline. The tokens themselves have ≥128
 * bits of entropy, so a fast hash is enough.
 */
export function tokenHash(pepper: string, token: string): Promise<string> {
  return hmacSha256Hex(pepper, token);
}

/** PBKDF2-SHA-256 (§2.1 recovery codes). Workers cap iterations at 100 000. */
export async function pbkdf2Hex(secret: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

/** Constant-time string comparison (both inputs are hashes/tokens of public length). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Uniform random integer in [0, n) without modulo bias (crypto.getRandomValues). */
export function randomInt(n: number): number {
  if (n <= 0) throw new Error('randomInt: n must be positive');
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}
