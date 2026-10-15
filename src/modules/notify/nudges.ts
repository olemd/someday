// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Nudges (§5.1): opt-in, `count` per week or month at random days and
 * minutes, drawn at the start of each period with crypto randomness and
 * persisted in `nudge_slots` (never shown to the user). Changing settings or
 * resuming from a pause redraws the rest of the period; slots inside a pause
 * are skipped, not postponed.
 */
import { drawNudges, isPaused, nextPeriodStart } from '../../core/notify';
import { iso, type Stmt } from '../../core/ports';
import type { Settings } from '../../core/settings';
import { cryptoRng } from '../../core/suggest';
import { ulid } from '../../core/ulid';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { createTranslator } from '../../shared/i18n/translate';
import { userSettings } from '../notices/service';
import { suggestFor } from '../suggest/service';
import type { Ctx } from '../types';
import { deliver } from './deliver';

/** Discard unsent future slots and draw the rest of the current period afresh. */
export async function redrawNudges(
  ctx: Ctx,
  userId: string,
  s: Settings,
  rng: () => number = cryptoRng,
): Promise<number> {
  const now = ctx.clock.now();
  const stmts: Stmt[] = [
    {
      sql: "UPDATE nudge_slots SET status = 'discarded' WHERE user_id = ? AND status = 'pending'",
      params: [userId],
    },
    {
      sql: `INSERT INTO notif_schedule (user_id, type, next_at) VALUES (?, 'nudge_draw', ?)
            ON CONFLICT(user_id, type) DO UPDATE SET next_at = excluded.next_at`,
      params: [userId, iso(nextPeriodStart(now, s.timezone, s.nudge_period))],
    },
  ];
  let drawn = 0;
  if (s.nudge_enabled && s.nudge_paused_until !== 'forever') {
    const draw = drawNudges({
      now,
      tz: s.timezone,
      period: s.nudge_period,
      count: s.nudge_count,
      windowStart: s.nudge_window_start,
      windowEnd: s.nudge_window_end,
      quietStart: s.quiet_start,
      quietEnd: s.quiet_end,
      rng,
    });
    drawn = draw.slots.length;
    for (const at of draw.slots) {
      stmts.push({
        sql: 'INSERT INTO nudge_slots (id, user_id, period_start, send_at) VALUES (?, ?, ?, ?)',
        params: [ulid(now), userId, draw.periodStart, iso(at)],
      });
    }
  }
  await ctx.db.batch(stmts);
  return drawn;
}

/** Cron: draw a new period for users whose period has started. */
export async function drawDueNudges(ctx: Ctx): Promise<void> {
  const due = await ctx.db.all<{ user_id: string }>(
    `SELECT s.user_id FROM notif_schedule s JOIN users u ON u.id = s.user_id
      WHERE s.type = 'nudge_draw' AND s.next_at <= ? AND u.deleted_at IS NULL AND u.disabled_at IS NULL
      LIMIT 100`,
    iso(ctx.clock.now()),
  );
  for (const d of due) await redrawNudges(ctx, d.user_id, await userSettings(ctx, d.user_id));
}

/** Cron: send the nudges whose time has come. */
export async function fireDueNudges(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const due = await ctx.db.all<{ id: string; user_id: string; send_at: string }>(
    `SELECT id, user_id, send_at FROM nudge_slots WHERE status = 'pending' AND send_at <= ?
      ORDER BY send_at LIMIT 100`,
    iso(now),
  );
  for (const slot of due) {
    const s = await userSettings(ctx, slot.user_id);
    const status = !s.nudge_enabled
      ? 'discarded'
      : isPaused(Date.parse(slot.send_at), s.nudge_paused_until)
        ? 'skipped_paused'
        : 'sent';
    // Claim the slot before doing anything: idempotent across overlapping runs.
    const claimed = await ctx.db.run(
      "UPDATE nudge_slots SET status = ? WHERE id = ? AND status = 'pending'",
      status,
      slot.id,
    );
    if (claimed.changes !== 1 || status !== 'sent') continue;
    const r = await suggestFor(ctx, { userId: slot.user_id, listIds: null }, s.suggest_filters);
    if (!r.suggestion) {
      await ctx.db.run("UPDATE nudge_slots SET status = 'skipped_empty' WHERE id = ?", slot.id);
      continue;
    }
    const { t } = createTranslator(s.locale, catalogs);
    await ctx.db.run(
      'UPDATE nudge_slots SET item_id = ? WHERE id = ?',
      r.suggestion.item.id,
      slot.id,
    );
    await deliver(
      ctx,
      slot.user_id,
      'nudge',
      {
        title: t('push.nudgeTitle'),
        body: [r.suggestion.item.title, r.suggestion.reason_texts[0]].filter(Boolean).join(' — '),
        url: `/items/${r.suggestion.item.id}`,
        tag: 'nudge',
      },
      { settings: s },
    );
  }
  await ctx.db.run(
    "DELETE FROM nudge_slots WHERE status != 'pending' AND send_at < ?",
    iso(now - 60 * 86_400_000),
  );
}
