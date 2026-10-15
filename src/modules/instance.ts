// SPDX-License-Identifier: AGPL-3.0-or-later
/** Instance settings an admin can change at runtime; they override env vars (§2.3). */
import type { Ctx } from './types';

export type RegistrationMode = 'invite' | 'open' | 'closed';

export async function registrationMode(ctx: Ctx): Promise<RegistrationMode> {
  const row = await ctx.db.first<{ value: string }>(
    "SELECT value FROM instance_settings WHERE key = 'registration_mode'",
  );
  const v = row ? (JSON.parse(row.value) as string) : null;
  return v === 'invite' || v === 'open' || v === 'closed' ? v : ctx.config.REGISTRATION_MODE;
}

export async function adminExists(ctx: Ctx): Promise<boolean> {
  return !!(await ctx.db.first("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"));
}
