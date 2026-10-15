// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline sync (§6).
 *
 * Pull: `GET /api/sync?since=<seq>` turns change-log rows after the cursor
 * into the current state of each touched entity, as the viewer may see it
 * now: present → upsert, gone or no longer visible → tombstone. Losing access
 * to a shared list yields tombstones for the list and its items.
 *
 * Push: queued offline writes (`ops`) are replayed in order; `op_id` makes a
 * replay idempotent, and item fields resolve last-write-wins with the
 * client's timestamps clamped to server time (in `writeItem`).
 */
import { HttpError } from '../../core/errors';
import { iso } from '../../core/ports';
import type { Item, List, LogEntry } from '../../shared/schemas/items';
import type { Actor } from '../data/changes';
import { deleteLog, logDone, updateLog, visibleLogEntries } from '../items/log';
import { queryItems, setSuggestionState, writeItem } from '../items/service';
import type { Access } from '../lists/access';
import { createList, getLists, updateList, updateMembership } from '../lists/service';
import type { Ctx } from '../types';

/** Change rows handled per pull; the client keeps pulling while `more` is true. */
export const PAGE_ROWS = 2000;
/** Change rows older than this are pruned; older cursors get a full sync. */
export const CHANGES_RETENTION_DAYS = 90;

export interface SyncResponse {
  cursor: number;
  /** True: replace everything local with this snapshot. */
  full: boolean;
  more: boolean;
  lists: List[];
  items: Item[];
  log: LogEntry[];
  deleted: { lists: string[]; items: string[]; log: string[] };
}

async function syncFloor(ctx: Ctx): Promise<number> {
  const row = await ctx.db.first<{ value: string }>(
    "SELECT value FROM instance_settings WHERE key = 'sync_floor'",
  );
  return row ? Number(JSON.parse(row.value)) : 0;
}

/** Everything the viewer can see: lists, their items, own + shared log entries. */
async function snapshot(ctx: Ctx, access: Access, cursor: number): Promise<SyncResponse> {
  const lists = await getLists(ctx, access);
  const items = await queryItems(ctx, access, {});
  const ids = items.map((i) => i.id);
  const log: LogEntry[] = [];
  // Chunked to stay under SQLite's parameter limit.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await ctx.db.all<{ id: string }>(
      `SELECT id FROM item_log WHERE item_id IN (${chunk.map(() => '?').join(', ')})
          AND (user_id = ? OR visibility = 'shared')`,
      ...chunk,
      access.userId,
    );
    log.push(
      ...(await visibleLogEntries(
        ctx,
        access.userId,
        rows.map((r) => r.id),
      )),
    );
  }
  return {
    cursor,
    full: true,
    more: false,
    lists,
    items,
    log,
    deleted: { lists: [], items: [], log: [] },
  };
}

export async function pull(ctx: Ctx, access: Access, since: number): Promise<SyncResponse> {
  const top = (await ctx.db.first<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM changes'))
    ?.seq;
  const head = top ?? 0;
  if (since <= 0 || since < (await syncFloor(ctx)) || since > head) {
    return snapshot(ctx, access, head);
  }
  // Rows that concern the viewer: on lists they are (or were) a member of,
  // public or addressed to them; plus anything addressed to them directly.
  const rows = await ctx.db.all<{
    seq: number;
    entity: string;
    entity_id: string;
    list_id: string | null;
  }>(
    `SELECT seq, entity, entity_id, list_id FROM changes
      WHERE seq > ? AND seq <= ?
        AND ((visible_to IS NULL AND list_id IN (SELECT list_id FROM list_members WHERE user_id = ?))
             OR visible_to = ?)
      ORDER BY seq LIMIT ?`,
    since,
    head,
    access.userId,
    access.userId,
    PAGE_ROWS,
  );
  const more = rows.length === PAGE_ROWS;
  const cursor = more ? rows[rows.length - 1]!.seq : head;

  const listIds = new Set<string>();
  const itemIds = new Set<string>();
  const logIds = new Set<string>();
  const lostLists = new Set<string>();
  for (const r of rows) {
    if (r.entity === 'list') listIds.add(r.entity_id);
    else if (r.entity === 'item') itemIds.add(r.entity_id);
    else if (r.entity === 'log') logIds.add(r.entity_id);
    else if (r.entity === 'member' && r.list_id) {
      listIds.add(r.list_id);
      if (r.entity_id === access.userId) lostLists.add(r.list_id);
    }
  }
  // Access lost (or regained) to a list: re-evaluate all its items too.
  for (const listId of lostLists) {
    for (const it of await ctx.db.all<{ id: string }>(
      'SELECT id FROM items WHERE list_id = ?',
      listId,
    )) {
      itemIds.add(it.id);
    }
  }

  const lists = await getLists(ctx, access, [...listIds]);
  const items: Item[] = [];
  const idList = [...itemIds];
  for (let i = 0; i < idList.length; i += 90) {
    items.push(...(await queryItems(ctx, access, { ids: idList.slice(i, i + 90) })));
  }
  const logList = [...logIds];
  const log: LogEntry[] = [];
  for (let i = 0; i < logList.length; i += 90) {
    log.push(...(await visibleLogEntries(ctx, access.userId, logList.slice(i, i + 90))));
  }
  // Regained access: the items came back, their visible log entries too.
  if (lostLists.size) {
    const lost = [...lostLists];
    const extra = await ctx.db.all<{ id: string }>(
      `SELECT lg.id FROM item_log lg JOIN items i ON i.id = lg.item_id
        WHERE i.list_id IN (${lost.map(() => '?').join(', ')})
          AND (lg.user_id = ? OR lg.visibility = 'shared')`,
      ...lost,
      access.userId,
    );
    const ids = extra.map((e) => e.id).filter((id) => !logIds.has(id));
    for (let i = 0; i < ids.length; i += 90) {
      log.push(...(await visibleLogEntries(ctx, access.userId, ids.slice(i, i + 90))));
    }
  }

  const has = <T extends { id: string }>(arr: T[]) => new Set(arr.map((x) => x.id));
  const seenLists = has(lists);
  const seenItems = has(items);
  const seenLog = has(log);
  return {
    cursor,
    full: false,
    more,
    lists,
    items,
    log,
    deleted: {
      lists: [...listIds].filter((id) => !seenLists.has(id)),
      items: idList.filter((id) => !seenItems.has(id)),
      log: logList.filter((id) => !seenLog.has(id)),
    },
  };
}

// ── Push ───────────────────────────────────────────────────────────────

export type Op =
  | {
      op_id: string;
      kind: 'item.upsert';
      id: string;
      fields: Record<string, unknown>;
      field_ts?: Record<string, number>;
      ts?: number;
    }
  | { op_id: string; kind: 'item.delete'; id: string }
  | { op_id: string; kind: 'item.snooze'; id: string; until: string | null }
  | { op_id: string; kind: 'item.seen'; id: string; at: number }
  | {
      op_id: string;
      kind: 'log.create';
      id: string;
      item_id: string;
      done_on: string;
      note?: string;
      rating?: number | null;
      visibility?: 'private' | 'anonymous' | 'shared';
    }
  | {
      op_id: string;
      kind: 'log.update';
      id: string;
      patch: {
        done_on?: string;
        note?: string;
        rating?: number | null;
        visibility?: 'private' | 'anonymous' | 'shared';
      };
    }
  | { op_id: string; kind: 'log.delete'; id: string }
  | { op_id: string; kind: 'list.create'; id: string; name: string }
  | { op_id: string; kind: 'list.update'; id: string; name: string }
  | {
      op_id: string;
      kind: 'list.membership';
      id: string;
      include_in_suggestions?: boolean;
      log_visibility?: 'private' | 'anonymous' | 'shared';
    };

export interface OpResult {
  op_id: string;
  ok: boolean;
  error?: string;
  message?: string;
  /** Item fields that lost to a newer write. */
  rejected?: string[];
}

async function applyOp(ctx: Ctx, access: Access, actor: Actor, op: Op): Promise<OpResult> {
  const now = ctx.clock.now();
  switch (op.kind) {
    case 'item.upsert': {
      const r = await writeItem(ctx, access, actor, {
        kind: 'upsert',
        id: op.id,
        fields: op.fields,
        field_ts: op.field_ts,
        ts: op.ts,
      });
      return { op_id: op.op_id, ok: true, rejected: r.rejected };
    }
    case 'item.delete':
      await writeItem(ctx, access, actor, { kind: 'delete', id: op.id });
      break;
    case 'item.snooze':
      await setSuggestionState(ctx, access, op.id, { snoozed_until: op.until });
      break;
    case 'item.seen':
      await setSuggestionState(ctx, access, op.id, {
        last_suggested_at: iso(Math.min(op.at, now)),
      });
      break;
    case 'log.create':
      await logDone(ctx, access, actor, op.item_id, {
        id: op.id,
        done_on: op.done_on,
        note: op.note ?? '',
        rating: op.rating ?? null,
        visibility: op.visibility,
      });
      break;
    case 'log.update':
      await updateLog(ctx, access, actor, op.id, op.patch);
      break;
    case 'log.delete':
      try {
        await deleteLog(ctx, access, actor, op.id);
      } catch (err) {
        // Already gone: deleting is idempotent.
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
      break;
    case 'list.create':
      await createList(ctx, access, actor, { id: op.id, name: op.name });
      break;
    case 'list.update':
      await updateList(ctx, access, actor, op.id, { name: op.name });
      break;
    case 'list.membership':
      await updateMembership(ctx, access, op.id, {
        include_in_suggestions: op.include_in_suggestions,
        log_visibility: op.log_visibility,
      });
      break;
  }
  return { op_id: op.op_id, ok: true };
}

/** Replay ops in order. A failing op is reported, never blocks the ones after it. */
export async function push(ctx: Ctx, access: Access, actor: Actor, ops: Op[]): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const op of ops) {
    const done = await ctx.db.first<{ result: string | null }>(
      'SELECT result FROM applied_ops WHERE op_id = ? AND user_id = ?',
      op.op_id,
      access.userId,
    );
    if (done) {
      results.push(
        done.result ? (JSON.parse(done.result) as OpResult) : { op_id: op.op_id, ok: true },
      );
      continue;
    }
    let result: OpResult;
    try {
      result = await applyOp(ctx, access, actor, op);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      result = { op_id: op.op_id, ok: false, error: err.code, message: err.message };
    }
    await ctx.db.run(
      'INSERT OR IGNORE INTO applied_ops (op_id, user_id, applied_at, result) VALUES (?, ?, ?, ?)',
      op.op_id,
      access.userId,
      iso(ctx.clock.now()),
      JSON.stringify(result),
    );
    results.push(result);
  }
  return results;
}

/** Cron: prune old change rows and op receipts; raise the floor for stale cursors. */
export async function pruneSyncTables(ctx: Ctx): Promise<void> {
  const cutoff = iso(ctx.clock.now() - CHANGES_RETENTION_DAYS * 86_400_000);
  const top = await ctx.db.first<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM changes WHERE at < ?',
    cutoff,
  );
  if (top?.seq) {
    await ctx.db.batch([
      {
        sql: `INSERT INTO instance_settings (key, value) VALUES ('sync_floor', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        params: [JSON.stringify(top.seq)],
      },
      { sql: 'DELETE FROM changes WHERE seq <= ?', params: [top.seq] },
    ]);
  }
  await ctx.db.run('DELETE FROM applied_ops WHERE applied_at < ?', cutoff);
}
