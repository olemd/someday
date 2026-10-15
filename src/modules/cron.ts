// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Scheduled work (§1.1): `runScheduled` is called every 15 minutes by the
 * Workers cron trigger, or by the in-process timer in the container. Each
 * module's hook runs in turn; one failing module never blocks the others.
 * Every hook must be idempotent: a restart may run it twice.
 */
import { modules } from '.';
import { purgeExpired } from './auth/session';
import type { Ctx } from './types';

export async function runScheduled(ctx: Ctx): Promise<void> {
  try {
    await purgeExpired(ctx);
  } catch (err) {
    ctx.log.error('cron failed', { module: 'auth', err: String(err) });
  }
  for (const m of modules) {
    if (!m.cron) continue;
    try {
      await m.cron(ctx);
    } catch (err) {
      ctx.log.error('cron failed', { module: m.name, err: String(err) });
    }
  }
}
