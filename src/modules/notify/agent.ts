// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Agent notifications (§5 `agent`, §8.2 `send_notification`): sent by a
 * connected MCP client, subject to the per-user toggle, quiet hours and a
 * daily cap (AGENT_NOTIFY_DAILY_MAX, overridable per user).
 */
import { iso } from '../../core/ports';
import { dateOf, startOfDay } from '../../core/time';
import { userSettings } from '../notices/service';
import type { Ctx } from '../types';
import { type DeliverResult, deliver } from './deliver';

export type AgentResult = DeliverResult | 'limit';

export async function sendAgentNotification(
  ctx: Ctx,
  userId: string,
  n: { title: string; body: string; itemId?: string | null },
): Promise<AgentResult> {
  const s = await userSettings(ctx, userId);
  if (!s.notify_agent) return 'disabled';
  const midnight = iso(startOfDay(dateOf(ctx.clock.now(), s.timezone), s.timezone));
  const used = await ctx.db.first<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM notif_log WHERE user_id = ?1 AND type = 'agent' AND sent_at >= ?2)
          + (SELECT COUNT(*) FROM push_deferred WHERE user_id = ?1 AND type = 'agent') AS n`,
    userId,
    midnight,
  );
  if ((used?.n ?? 0) >= s.agent_daily_max) return 'limit';
  return deliver(
    ctx,
    userId,
    'agent',
    { title: n.title, body: n.body, url: n.itemId ? `/items/${n.itemId}` : '/', tag: 'agent' },
    { settings: s },
  );
}
