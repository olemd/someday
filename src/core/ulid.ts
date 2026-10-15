// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ULIDs (§1): 48-bit millisecond timestamp + 80 random bits, Crockford
 * base32. Sortable by creation time and safe to generate on the client, which
 * offline creates need (§6).
 */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let r = '';
  for (const b of rand) r += CROCKFORD[b & 31];
  return ts + r;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const isUlid = (s: string): boolean => ULID_RE.test(s);
