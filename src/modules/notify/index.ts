// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notifications cron (§5): every 15 minutes, set-based where it can be and
 * per-user only for users with something due. All steps are idempotent.
 */
import { iso } from '../../core/ports';
import { onSettingsChanged } from '../settings';
import { userSettings } from '../notices/service';
import type { Ctx, Module } from '../types';
import { flushDeferred } from './deliver';
import { drawDueNudges, fireDueNudges, redrawNudges } from './nudges';
import { flushShared } from './shared';
import { runWindowChecks } from './window';

/** Give every active user their schedule rows (new users are picked up here). */
async function ensureSchedules(ctx: Ctx) {
  const now = iso(ctx.clock.now());
  await ctx.db.batch(
    ['window', 'nudge_draw'].map((type) => ({
      sql: `INSERT INTO notif_schedule (user_id, type, next_at)
            SELECT id, ?, ? FROM users u
             WHERE u.deleted_at IS NULL AND u.disabled_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM notif_schedule s WHERE s.user_id = u.id AND s.type = ?)`,
      params: [type, now, type],
    })),
  );
}

export async function notifyCron(ctx: Ctx): Promise<void> {
  const steps: [string, (c: Ctx) => Promise<void>][] = [
    ['schedules', ensureSchedules],
    ['nudge draw', drawDueNudges],
    ['nudges', fireDueNudges],
    ['window', runWindowChecks],
    ['shared', flushShared],
    ['deferred', flushDeferred],
  ];
  // Each step is independent: one failing never blocks the others.
  for (const [name, step] of steps) {
    try {
      await step(ctx);
    } catch (err) {
      ctx.log.error('notify step failed', { step: name, err: String(err) });
    }
  }
}

const NUDGE_KEYS = new Set([
  'nudge_enabled',
  'nudge_count',
  'nudge_period',
  'nudge_window_start',
  'nudge_window_end',
  'nudge_paused_until',
  'quiet_start',
  'quiet_end',
  'timezone',
]);

// Changing nudge settings, pausing or resuming redraws the rest of the period;
// a new time zone moves the 09:00 check.
onSettingsChanged(async (ctx, userId, changed) => {
  if (changed.some((k) => NUDGE_KEYS.has(k))) {
    await redrawNudges(ctx, userId, await userSettings(ctx, userId));
  }
  if (changed.includes('timezone')) {
    await ctx.db.run(
      "UPDATE notif_schedule SET next_at = ? WHERE user_id = ? AND type = 'window'",
      iso(ctx.clock.now()),
      userId,
    );
  }
});

export const notifyModule: Module = { name: 'notify', cron: notifyCron };
