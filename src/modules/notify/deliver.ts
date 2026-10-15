// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Delivering a notification (§5): per-type toggles, quiet hours (non-urgent
 * pushes wait until they end), and a log for per-type caps.
 */
import { quietEndsAt } from '../../core/notify';
import { iso } from '../../core/ports';
import type { Settings } from '../../core/settings';
import { ulid } from '../../core/ulid';
import { userSettings } from '../notices/service';
import { type PushPayload, sendToUser } from '../push/service';
import type { Ctx } from '../types';

export type NotifType = 'nudge' | 'window' | 'shared' | 'agent';

export function typeEnabled(s: Settings, type: NotifType): boolean {
  switch (type) {
    case 'nudge':
      return s.nudge_enabled;
    case 'window':
      return s.notify_window;
    case 'shared':
      return s.notify_shared;
    case 'agent':
      return s.notify_agent;
  }
}

export type DeliverResult = 'sent' | 'deferred' | 'disabled';

export async function deliver(
  ctx: Ctx,
  userId: string,
  type: NotifType,
  payload: PushPayload,
  opts: { settings?: Settings } = {},
): Promise<DeliverResult> {
  const s = opts.settings ?? (await userSettings(ctx, userId));
  if (!typeEnabled(s, type)) return 'disabled';
  const now = ctx.clock.now();
  const until = quietEndsAt(now, s.timezone, s.quiet_start, s.quiet_end);
  if (until > now) {
    await ctx.db.run(
      `INSERT INTO push_deferred (id, user_id, type, payload, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ulid(now),
      userId,
      type,
      JSON.stringify(payload),
      iso(until),
      iso(now),
    );
    return 'deferred';
  }
  await sendNow(ctx, userId, type, payload);
  return 'sent';
}

async function sendNow(ctx: Ctx, userId: string, type: NotifType, payload: PushPayload) {
  await ctx.db.run(
    'INSERT INTO notif_log (user_id, type, sent_at) VALUES (?, ?, ?)',
    userId,
    type,
    iso(ctx.clock.now()),
  );
  await sendToUser(ctx, userId, payload);
}

/** Cron: send pushes held back by quiet hours once they are over. */
export async function flushDeferred(ctx: Ctx): Promise<void> {
  const now = iso(ctx.clock.now());
  const due = await ctx.db.all<{ id: string; user_id: string; type: NotifType; payload: string }>(
    'SELECT id, user_id, type, payload FROM push_deferred WHERE not_before <= ? ORDER BY not_before LIMIT 100',
    now,
  );
  for (const d of due) {
    // Claim first: a concurrent or repeated run must not send twice.
    const r = await ctx.db.run('DELETE FROM push_deferred WHERE id = ?', d.id);
    if (r.changes !== 1) continue;
    const s = await userSettings(ctx, d.user_id);
    if (!typeEnabled(s, d.type)) continue;
    await sendNow(ctx, d.user_id, d.type, JSON.parse(d.payload) as PushPayload);
  }
  // Keep the log short: only caps (per day) read it.
  await ctx.db.run(
    'DELETE FROM notif_log WHERE sent_at < ?',
    iso(ctx.clock.now() - 3 * 86_400_000),
  );
}
