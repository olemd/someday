// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recovery codes (§2.1): 10 one-time codes, shown once, stored as
 * PBKDF2-SHA-256 hashes with a per-code salt.
 *
 * A code looks like `ABCD-EFGH-JKMN-PQRS-TVWX`: the first group is a public
 * lookup key (stored in clear), the remaining 80 bits are the secret. A login
 * therefore costs one PBKDF2 run, not one per stored code, and there is no
 * username to type.
 */
import { normalizeCrockford, pbkdf2Hex, randomCrockford, randomToken } from '../../core/crypto';
import type { Stmt } from '../../core/ports';
import type { Ctx } from '../types';

export const RECOVERY_CODE_COUNT = 10;

export function formatRecoveryCode(raw: string): string {
  return raw.match(/.{4}/g)!.join('-');
}

export function splitRecoveryCode(input: string): { lookup: string; secret: string } | null {
  const n = normalizeCrockford(input);
  if (n.length !== 20) return null;
  return { lookup: n.slice(0, 4), secret: n.slice(4) };
}

/** New codes for `userId`: the codes to show, and statements replacing the old ones. */
export async function newRecoveryCodes(
  ctx: Ctx,
  userId: string,
  guard?: { sql: string; params: Stmt['params'] },
): Promise<{ codes: string[]; stmts: Stmt[] }> {
  const codes: string[] = [];
  const stmts: Stmt[] = [{ sql: 'DELETE FROM recovery_codes WHERE user_id = ?', params: [userId] }];
  const lookups = new Set<string>();
  while (codes.length < RECOVERY_CODE_COUNT) {
    const raw = randomCrockford(20);
    const lookup = raw.slice(0, 4);
    if (lookups.has(lookup)) continue;
    lookups.add(lookup);
    codes.push(formatRecoveryCode(raw));
  }
  const rows = await Promise.all(
    codes.map(async (code) => {
      const { lookup, secret } = splitRecoveryCode(code)!;
      const salt = randomToken(16);
      return {
        lookup,
        salt,
        hash: await pbkdf2Hex(secret, salt, ctx.config.RECOVERY_PBKDF2_ITERATIONS),
      };
    }),
  );
  for (const r of rows) {
    // A lookup collision with another user's code is astronomically rare
    // (20 bits, few codes); OR REPLACE would steal it, so IGNORE and accept
    // that that one code will not work rather than break someone else's.
    stmts.push({
      sql: `INSERT OR IGNORE INTO recovery_codes (lookup, user_id, salt, hash)
            SELECT ?, ?, ?, ? ${guard ? `WHERE ${guard.sql}` : ''}`,
      params: [r.lookup, userId, r.salt, r.hash, ...(guard?.params ?? [])],
    });
  }
  return { codes, stmts };
}

/** Verify and consume a recovery code; returns the user ID or null. */
export async function redeemRecoveryCode(ctx: Ctx, input: string): Promise<string | null> {
  const parts = splitRecoveryCode(input);
  if (!parts) return null;
  const row = await ctx.db.first<{ user_id: string; salt: string; hash: string }>(
    'SELECT user_id, salt, hash FROM recovery_codes WHERE lookup = ? AND used_at IS NULL',
    parts.lookup,
  );
  if (!row) return null;
  const hash = await pbkdf2Hex(parts.secret, row.salt, ctx.config.RECOVERY_PBKDF2_ITERATIONS);
  if (hash !== row.hash) return null;
  const r = await ctx.db.run(
    'UPDATE recovery_codes SET used_at = ? WHERE lookup = ? AND used_at IS NULL',
    new Date(ctx.clock.now()).toISOString(),
    parts.lookup,
  );
  return r.changes === 1 ? row.user_id : null;
}
