// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared-list activity (§5 `shared`): items added and *shared* log entries by
 * others, batched to at most one push per list per SHARED_PUSH_INTERVAL_MIN.
 * Private and anonymous entries never get here (timing would de-anonymise).
 */
import { isQuiet } from '../../core/notify';
import { iso, type Stmt } from '../../core/ports';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { createTranslator } from '../../shared/i18n/translate';
import { userSettings } from '../notices/service';
import type { Ctx } from '../types';
import { deliver } from './deliver';

/**
 * Queue a notification for every other member of `listId`, as part of the
 * write's batch (optionally gated on the write having happened).
 */
export function enqueueShared(
  ctx: Ctx,
  e: { listId: string; kind: 'item_added' | 'log_shared'; itemId: string; actorId: string },
  gate?: { sql: string; params: (string | number | null)[] },
): Stmt {
  return {
    sql: `INSERT INTO shared_queue (id, recipient, list_id, kind, item_id, actor_name, created_at)
          SELECT lower(hex(randomblob(16))), m.user_id, ?, ?, ?,
                 COALESCE((SELECT display_name FROM users WHERE id = ?), ''), ?
            FROM list_members m
           WHERE m.list_id = ? AND m.user_id != ? ${gate ? `AND ${gate.sql}` : ''}`,
    params: [
      e.listId,
      e.kind,
      e.itemId,
      e.actorId,
      iso(ctx.clock.now()),
      e.listId,
      e.actorId,
      ...(gate?.params ?? []),
    ],
  };
}

interface Group {
  recipient: string;
  list_id: string;
  list_name: string;
  n: number;
  actors: string;
  kinds: string;
  item_id: string;
}

export async function flushShared(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const since = iso(now - ctx.config.SHARED_PUSH_INTERVAL_MIN * 60_000);
  const groups = await ctx.db.all<Group>(
    `SELECT q.recipient, q.list_id, l.name AS list_name, COUNT(*) AS n,
            json_group_array(DISTINCT q.actor_name) AS actors,
            json_group_array(DISTINCT q.kind) AS kinds,
            MAX(q.item_id) AS item_id
       FROM shared_queue q JOIN lists l ON l.id = q.list_id AND l.deleted_at IS NULL
      WHERE NOT EXISTS (SELECT 1 FROM notif_schedule s
                         WHERE s.user_id = q.recipient AND s.type = 'shared:' || q.list_id
                           AND s.last_sent > ?)
      GROUP BY q.recipient, q.list_id
      LIMIT 100`,
    since,
  );
  for (const g of groups) {
    const s = await userSettings(ctx, g.recipient);
    // Quiet hours: the batch simply stays queued until they are over.
    if (isQuiet(now, s.timezone, s.quiet_start, s.quiet_end)) continue;
    const { t } = createTranslator(s.locale, catalogs);
    const title =
      g.n === 1
        ? ((
            await ctx.db.first<{ title: string }>('SELECT title FROM items WHERE id = ?', g.item_id)
          )?.title ?? null)
        : null;
    const actors = JSON.parse(g.actors) as string[];
    const kinds = JSON.parse(g.kinds) as string[];
    const who =
      actors.length === 1
        ? actors[0]!
        : t('push.sharedSeveral', { name: actors[0]!, count: actors.length - 1 });
    const body = title
      ? t(kinds[0] === 'item_added' ? 'push.sharedAddedOne' : 'push.sharedDidOne', {
          who,
          title,
        })
      : t('push.sharedMany', { who, count: g.n });
    await deliver(
      ctx,
      g.recipient,
      'shared',
      {
        title: g.list_name,
        body,
        url: title ? `/items/${g.item_id}` : `/lists/${g.list_id}`,
        tag: `shared-${g.list_id}`,
      },
      { settings: s },
    );
    await ctx.db.batch([
      {
        sql: 'DELETE FROM shared_queue WHERE recipient = ? AND list_id = ? AND created_at <= ?',
        params: [g.recipient, g.list_id, iso(now)],
      },
      {
        sql: `INSERT INTO notif_schedule (user_id, type, next_at, last_sent) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, type) DO UPDATE SET last_sent = excluded.last_sent`,
        params: [g.recipient, `shared:${g.list_id}`, iso(now), iso(now)],
      },
    ]);
  }
}
