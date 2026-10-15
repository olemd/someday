// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The done log (§3.3). "Done" is per user: on shared lists logging never
 * changes the item for others; only on single-member lists does a
 * non-repeatable item become `done`. Visibility is private / anonymous /
 * shared, and other members only ever see shared entries (and an aggregate
 * count above the group-size threshold).
 */
import { HttpError, badRequest, notFound } from '../../core/errors';
import { iso, type Stmt } from '../../core/ports';
import { ulid } from '../../core/ulid';
import type { LogEntry, Status, Visibility } from '../../shared/schemas/items';
import { type Actor, changeStmt } from '../data/changes';
import type { Access } from '../lists/access';
import { anonThreshold } from '../lists/service';
import { enqueueShared } from '../notify/shared';
import type { Ctx } from '../types';
import { getItem, ID_RE } from './service';

interface ListInfo {
  list_id: string;
  member_count: number;
  anon_count_min_members: number | null;
  log_visibility: Visibility;
  status: Status;
  repeatable: number;
}

async function listInfo(ctx: Ctx, userId: string, itemId: string): Promise<ListInfo> {
  const row = await ctx.db.first<ListInfo>(
    `SELECT i.list_id, i.status, i.repeatable, l.anon_count_min_members, m.log_visibility,
            (SELECT COUNT(*) FROM list_members WHERE list_id = i.list_id) AS member_count
       FROM items i JOIN lists l ON l.id = i.list_id
       JOIN list_members m ON m.list_id = i.list_id AND m.user_id = ?
      WHERE i.id = ?`,
    userId,
    itemId,
  );
  if (!row) throw notFound('item_not_found');
  return row;
}

/** Resolve the visibility to store, enforcing the anonymity threshold. */
function effectiveVisibility(ctx: Ctx, info: ListInfo, requested: Visibility | undefined) {
  // On a private list the field is irrelevant: stored as private.
  if (info.member_count <= 1) return 'private' as const;
  const v = requested ?? info.log_visibility;
  if (v === 'anonymous' && info.member_count < anonThreshold(ctx, info.anon_count_min_members)) {
    throw new HttpError(
      409,
      'anonymous_unavailable',
      'Too few members on this list to stay anonymous',
    );
  }
  return v;
}

/**
 * Change rows for a log entry: shared entries (and entries that just stopped
 * being shared) concern every member; private and anonymous ones only the
 * author, so their timing never reaches anyone else (§3.3).
 */
function logChanges(
  ctx: Ctx,
  actor: Actor,
  userId: string,
  entryId: string,
  listId: string,
  itemId: string,
  op: 'upsert' | 'delete',
  publicChange: boolean,
): Stmt[] {
  const visibleTo = publicChange ? null : userId;
  return [
    changeStmt(ctx, { entity: 'log', entityId: entryId, listId, op, actor, visibleTo }),
    // The item's done_for_me / counts / names changed for these readers.
    changeStmt(ctx, { entity: 'item', entityId: itemId, listId, op: 'upsert', actor, visibleTo }),
  ];
}

export async function logDone(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  itemId: string,
  input: {
    id?: string;
    done_on: string;
    note: string;
    rating: number | null;
    visibility?: Visibility;
  },
): Promise<LogEntry> {
  // Viewers may log too: it is personal and does not change the item.
  await getItem(ctx, access, itemId);
  const info = await listInfo(ctx, access.userId, itemId);
  if (input.id !== undefined && !ID_RE.test(input.id)) throw badRequest('bad_id');
  const id = input.id ?? ulid(ctx.clock.now());
  // Idempotent replay of an offline "done".
  const existing = await ctx.db.first('SELECT 1 FROM item_log WHERE id = ?', id);
  if (existing) return getLogEntry(ctx, access.userId, id);

  const visibility = effectiveVisibility(ctx, info, input.visibility);
  const now = iso(ctx.clock.now());
  // Only on single-member lists does logging close a non-repeatable item.
  const closes = info.member_count === 1 && info.repeatable === 0 && info.status !== 'done';
  const stmts: Stmt[] = [
    {
      sql: `INSERT INTO item_log (id, item_id, user_id, done_on, note, rating, visibility,
              prev_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        itemId,
        access.userId,
        input.done_on,
        input.note,
        input.rating,
        visibility,
        closes ? info.status : null,
        now,
        now,
      ],
    },
  ];
  if (closes) stmts.push(statusStmt(ctx, itemId, 'done'));
  // Remember the choice for this list (§3.3).
  if (input.visibility && info.member_count > 1) {
    stmts.push({
      sql: 'UPDATE list_members SET log_visibility = ? WHERE list_id = ? AND user_id = ?',
      params: [visibility, info.list_id, access.userId],
    });
  }
  stmts.push(
    ...logChanges(
      ctx,
      actor,
      access.userId,
      id,
      info.list_id,
      itemId,
      'upsert',
      visibility === 'shared' || closes,
    ),
  );
  // Only shared entries ever notify others; private and anonymous never do.
  if (visibility === 'shared') {
    stmts.push(
      enqueueShared(ctx, {
        listId: info.list_id,
        kind: 'log_shared',
        itemId,
        actorId: access.userId,
      }),
    );
  }
  await ctx.db.batch(stmts);
  return getLogEntry(ctx, access.userId, id);
}

/** Set an item's status and bump its status clock (for LWW). */
function statusStmt(ctx: Ctx, itemId: string, status: Status): Stmt {
  const now = ctx.clock.now();
  return {
    sql: `UPDATE items SET status = ?, updated_at = ?,
            field_clock = json_set(field_clock, '$.status', ?, '$._rev', ?) WHERE id = ?`,
    params: [status, iso(now), now, ulid(now), itemId],
  };
}

interface LogRow {
  id: string;
  item_id: string;
  user_id: string;
  display_name: string;
  done_on: string;
  note: string;
  rating: number | null;
  visibility: Visibility;
  prev_status: Status | null;
  created_at: string;
  updated_at: string;
}

function toEntry(r: LogRow, viewer: string): LogEntry {
  const mine = r.user_id === viewer;
  return {
    id: r.id,
    item_id: r.item_id,
    user_id: r.user_id,
    user_name: mine ? null : r.display_name,
    done_on: r.done_on,
    note: r.note,
    rating: r.rating,
    visibility: r.visibility,
    created_at: r.created_at,
    updated_at: r.updated_at,
    mine,
  };
}

const LOG_SELECT = `SELECT lg.*, u.display_name FROM item_log lg JOIN users u ON u.id = lg.user_id`;

/** Log entries of an item the viewer may see: their own, plus others' shared ones. */
export async function itemLog(ctx: Ctx, access: Access, itemId: string): Promise<LogEntry[]> {
  await getItem(ctx, access, itemId);
  const rows = await ctx.db.all<LogRow>(
    `${LOG_SELECT} WHERE lg.item_id = ? AND (lg.user_id = ? OR lg.visibility = 'shared')
      ORDER BY lg.done_on DESC, lg.created_at DESC`,
    itemId,
    access.userId,
  );
  return rows.map((r) => toEntry(r, access.userId));
}

async function getLogEntry(ctx: Ctx, viewer: string, id: string): Promise<LogEntry> {
  const row = await ctx.db.first<LogRow>(`${LOG_SELECT} WHERE lg.id = ?`, id);
  if (!row || (row.user_id !== viewer && row.visibility !== 'shared')) {
    throw notFound('log_not_found');
  }
  return toEntry(row, viewer);
}

/** The author's own entry, or 404 (others' entries are never editable). */
async function ownEntry(ctx: Ctx, access: Access, id: string): Promise<LogRow> {
  const row = await ctx.db.first<LogRow>(
    `${LOG_SELECT} WHERE lg.id = ? AND lg.user_id = ?`,
    id,
    access.userId,
  );
  if (!row) throw notFound('log_not_found');
  // The entry's item must still be visible through this access (OAuth list limits).
  await getItem(ctx, access, row.item_id);
  return row;
}

export async function updateLog(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  id: string,
  patch: { done_on?: string; note?: string; rating?: number | null; visibility?: Visibility },
): Promise<LogEntry> {
  const row = await ownEntry(ctx, access, id);
  const info = await listInfo(ctx, access.userId, row.item_id);
  const visibility =
    patch.visibility !== undefined ? effectiveVisibility(ctx, info, patch.visibility) : undefined;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries({ ...patch, visibility })) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v as string | number | null);
  }
  if (!sets.length) return toEntry(row, access.userId);
  // Others must hear about it if the entry is, or was, shared.
  const publicChange = row.visibility === 'shared' || visibility === 'shared';
  const becomesShared = visibility === 'shared' && row.visibility !== 'shared';
  await ctx.db.batch([
    {
      sql: `UPDATE item_log SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      params: [...params, iso(ctx.clock.now()), id],
    },
    ...(becomesShared
      ? [
          enqueueShared(ctx, {
            listId: info.list_id,
            kind: 'log_shared',
            itemId: row.item_id,
            actorId: access.userId,
          }),
        ]
      : []),
    ...logChanges(ctx, actor, access.userId, id, info.list_id, row.item_id, 'upsert', publicChange),
  ]);
  return getLogEntry(ctx, access.userId, id);
}

/** Undo (§3.3): remove the entry and restore the status it changed, if still unchanged. */
export async function deleteLog(ctx: Ctx, access: Access, actor: Actor, id: string) {
  const row = await ownEntry(ctx, access, id);
  const info = await listInfo(ctx, access.userId, row.item_id);
  const stmts: Stmt[] = [{ sql: 'DELETE FROM item_log WHERE id = ?', params: [id] }];
  const restores = row.prev_status !== null && info.status === 'done';
  if (restores) stmts.push(statusStmt(ctx, row.item_id, row.prev_status!));
  stmts.push(
    ...logChanges(
      ctx,
      actor,
      access.userId,
      id,
      info.list_id,
      row.item_id,
      'delete',
      row.visibility === 'shared' || restores,
    ),
  );
  await ctx.db.batch(stmts);
}

/** Log entries visible to `viewer` by id (sync), or null when not visible. */
export async function visibleLogEntries(
  ctx: Ctx,
  viewer: string,
  ids: string[],
): Promise<LogEntry[]> {
  if (!ids.length) return [];
  const rows = await ctx.db.all<LogRow>(
    `${LOG_SELECT}
       JOIN items i ON i.id = lg.item_id
       JOIN lists l ON l.id = i.list_id AND l.deleted_at IS NULL
       JOIN list_members m ON m.list_id = i.list_id AND m.user_id = ?
      WHERE lg.id IN (${ids.map(() => '?').join(', ')})
        AND (lg.user_id = ? OR lg.visibility = 'shared')`,
    viewer,
    ...ids,
    viewer,
  );
  return rows.map((r) => toEntry(r, viewer));
}
