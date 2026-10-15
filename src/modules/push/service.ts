// SPDX-License-Identifier: AGPL-3.0-or-later
/** Delivering Web Push payloads to all of one user's devices (§5). */
import { iso, type PushSubscriptionKeys } from '../../core/ports';
import type { Ctx } from '../types';

export interface PushPayload {
  title: string;
  body: string;
  /** Deep link opened when the notification is clicked (path on PUBLIC_ORIGIN). */
  url: string;
  tag?: string;
  /** Optional action buttons: [{action, title}] with the URL to POST for each. */
  actions?: { action: string; title: string; url: string }[];
}

/**
 * Deliver one payload to every subscription of `userId`. 404/410 → the
 * subscription is gone and is pruned; other errors are logged, no retry.
 */
export async function sendToUser(
  ctx: Ctx,
  userId: string,
  payload: PushPayload,
  opts: { urgency?: 'normal' | 'high'; ttl?: number } = {},
): Promise<{ sent: number; removed: number }> {
  if (!ctx.push) return { sent: 0, removed: 0 };
  const subs = await ctx.db.all<PushSubscriptionKeys>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    userId,
  );
  let sent = 0;
  let removed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        const status = await ctx.push!.send(s, JSON.stringify(payload), {
          urgency: opts.urgency ?? 'normal',
          ttl: opts.ttl ?? 86_400,
        });
        if (status === 404 || status === 410) {
          await ctx.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
          removed++;
        } else if (status >= 200 && status < 300) {
          await ctx.db.run(
            'UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?',
            iso(ctx.clock.now()),
            s.endpoint,
          );
          sent++;
        } else {
          ctx.log.warn('push rejected', { status, endpoint: new URL(s.endpoint).host });
        }
      } catch (err) {
        ctx.log.error('push failed', { err: String(err), endpoint: new URL(s.endpoint).host });
      }
    }),
  );
  return { sent, removed };
}
