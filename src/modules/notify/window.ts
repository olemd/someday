// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Window reminders (§5 `window`): daily at the user's 09:00, ideas whose
 * date window or season opens today, or closes in 7 days. Scheduled per user
 * in `notif_schedule`, so cron only touches users who are due.
 */
import { nextLocalTime, seasonStartsOn } from '../../core/notify';
import { iso } from '../../core/ports';
import { seasonEnd } from '../../core/suggest';
import { addDays, dateOf, minuteOfDay } from '../../core/time';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { createTranslator } from '../../shared/i18n/translate';
import { queryItems } from '../items/service';
import { userSettings } from '../notices/service';
import type { Ctx } from '../types';
import { deliver } from './deliver';

export const WINDOW_TIME = '09:00';
const WARN_DAYS = 7;

interface Event {
  id: string;
  title: string;
  kind: 'opens' | 'seasonStarts' | 'closes' | 'seasonEnds';
}

export async function windowEvents(ctx: Ctx, userId: string, today: string): Promise<Event[]> {
  const items = await queryItems(
    ctx,
    { userId, listIds: null },
    { status: ['idea', 'planned'], open_for_me: true },
  );
  const soon = addDays(today, WARN_DAYS);
  const out: Event[] = [];
  for (const i of items) {
    if (i.hidden_at) continue; // hidden for this user
    if (i.valid_from === today) out.push({ id: i.id, title: i.title, kind: 'opens' });
    else if (seasonStartsOn(i.months, today))
      out.push({ id: i.id, title: i.title, kind: 'seasonStarts' });
    else if (i.valid_to === soon) out.push({ id: i.id, title: i.title, kind: 'closes' });
    else if (i.months && seasonEnd(i.months, today) === soon) {
      out.push({ id: i.id, title: i.title, kind: 'seasonEnds' });
    }
  }
  return out;
}

/** Cron: run the 09:00 check for every user whose time has come. */
export async function runWindowChecks(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const due = await ctx.db.all<{ user_id: string; last_sent: string | null }>(
    `SELECT s.user_id, s.last_sent FROM notif_schedule s JOIN users u ON u.id = s.user_id
      WHERE s.type = 'window' AND s.next_at <= ? AND u.deleted_at IS NULL AND u.disabled_at IS NULL
      LIMIT 100`,
    iso(now),
  );
  for (const d of due) {
    const s = await userSettings(ctx, d.user_id);
    const today = dateOf(now, s.timezone);
    const next = nextLocalTime(now, s.timezone, WINDOW_TIME);
    // Too early today, or already done today: just (re)schedule.
    const early = minuteOfDay(now, s.timezone) < 9 * 60;
    if (!early && d.last_sent !== today) {
      // Mark first: a crash after this point never double-sends.
      await ctx.db.run(
        "UPDATE notif_schedule SET last_sent = ?, next_at = ? WHERE user_id = ? AND type = 'window'",
        today,
        iso(next),
        d.user_id,
      );
      if (s.notify_window) {
        const events = await windowEvents(ctx, d.user_id, today);
        if (events.length) {
          const { t } = createTranslator(s.locale, catalogs);
          const first = events[0]!;
          await deliver(
            ctx,
            d.user_id,
            'window',
            events.length === 1
              ? {
                  title: first.title,
                  body: t(`push.window_${first.kind}`),
                  url: `/items/${first.id}`,
                  tag: 'window',
                }
              : {
                  title: t('push.windowManyTitle', { count: events.length }),
                  body: events.map((e) => e.title).join(', '),
                  url: '/',
                  tag: 'window',
                },
            { settings: s },
          );
        }
      }
      continue;
    }
    await ctx.db.run(
      "UPDATE notif_schedule SET next_at = ? WHERE user_id = ? AND type = 'window'",
      iso(early ? nextLocalTime(now - 1, s.timezone, WINDOW_TIME) : next),
      d.user_id,
    );
  }
}
