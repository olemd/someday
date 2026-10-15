// SPDX-License-Identifier: AGPL-3.0-or-later
/** Lists (§3.1): reading with the viewer's membership, creating, renaming, deleting. */
import { conflict, notFound } from '../../core/errors';
import { iso, type Stmt } from '../../core/ports';
import { ulid } from '../../core/ulid';
import type { List, Member, Role, Visibility } from '../../shared/schemas/items';
import { type Actor, changeStmt } from '../data/changes';
import type { Ctx } from '../types';
import { type Access, requireListRole } from './access';

/** The effective group-size threshold for anonymous counts on a list (§3.3). */
export function anonThreshold(ctx: Ctx, listOverride: number | null): number {
  return Math.max(3, listOverride ?? ctx.config.ANON_COUNT_MIN_MEMBERS);
}

interface ListRow {
  id: string;
  name: string;
  role: Role;
  created_at: string;
  updated_at: string;
  include_in_suggestions: number;
  log_visibility: Visibility;
  anon_count_min_members: number | null;
  members: string;
}

const LIST_SELECT = `
  SELECT l.id, l.name, m.role, l.created_at, l.updated_at, m.include_in_suggestions,
         m.log_visibility, l.anon_count_min_members,
         (SELECT json_group_array(json_object('user_id', mm.user_id, 'display_name', u.display_name,
                                              'role', mm.role))
            FROM list_members mm JOIN users u ON u.id = mm.user_id
           WHERE mm.list_id = l.id) AS members
    FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ?
   WHERE l.deleted_at IS NULL`;

function toList(ctx: Ctx, r: ListRow): List {
  const members = (JSON.parse(r.members) as Member[]).sort((a, b) =>
    a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.display_name.localeCompare(b.display_name),
  );
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    created_at: r.created_at,
    updated_at: r.updated_at,
    member_count: members.length,
    members,
    include_in_suggestions: r.include_in_suggestions === 1,
    log_visibility: r.log_visibility,
    anon_count_min_members: r.anon_count_min_members,
    anonymous_available: members.length >= anonThreshold(ctx, r.anon_count_min_members),
  };
}

export async function getLists(ctx: Ctx, access: Access, ids?: string[]): Promise<List[]> {
  let sql = LIST_SELECT;
  const params: string[] = [access.userId];
  const restrict = ids ?? access.listIds;
  if (restrict) {
    if (restrict.length === 0) return [];
    sql += ` AND l.id IN (${restrict.map(() => '?').join(', ')})`;
    params.push(...restrict);
  }
  sql += ' ORDER BY l.created_at';
  return (await ctx.db.all<ListRow>(sql, ...params)).map((r) => toList(ctx, r));
}

export async function getList(ctx: Ctx, access: Access, id: string): Promise<List> {
  const [list] = await getLists(ctx, access, [id]);
  if (!list) throw notFound('list_not_found');
  return list;
}

export async function createList(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  input: { id?: string; name: string },
): Promise<List> {
  const now = ctx.clock.now();
  const id = input.id ?? ulid(now);
  // Replayed offline create: the list already exists and is ours.
  if (input.id && (await ctx.db.first('SELECT 1 FROM lists WHERE id = ?', id))) {
    return getList(ctx, access, id);
  }
  await ctx.db.batch([
    {
      sql: 'INSERT INTO lists (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      params: [id, input.name, access.userId, iso(now), iso(now)],
    },
    {
      sql: "INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
      params: [id, access.userId, iso(now)],
    },
    changeStmt(ctx, { entity: 'list', entityId: id, listId: id, op: 'upsert', actor }),
  ]);
  return getList(ctx, { ...access, listIds: null }, id);
}

export async function updateList(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  id: string,
  patch: { name?: string; anon_count_min_members?: number | null },
): Promise<List> {
  await requireListRole(ctx, access, id, 'owner');
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.anon_count_min_members !== undefined) {
    sets.push('anon_count_min_members = ?');
    params.push(patch.anon_count_min_members);
  }
  if (sets.length) {
    await ctx.db.batch([
      {
        sql: `UPDATE lists SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
        params: [...params, iso(ctx.clock.now()), id],
      },
      changeStmt(ctx, { entity: 'list', entityId: id, listId: id, op: 'upsert', actor }),
    ]);
  }
  return getList(ctx, access, id);
}

/** The viewer's own membership preferences. */
export async function updateMembership(
  ctx: Ctx,
  access: Access,
  id: string,
  patch: { include_in_suggestions?: boolean; log_visibility?: Visibility },
): Promise<List> {
  await requireListRole(ctx, access, id, 'viewer');
  const stmts: Stmt[] = [];
  if (patch.include_in_suggestions !== undefined) {
    stmts.push({
      sql: 'UPDATE list_members SET include_in_suggestions = ? WHERE list_id = ? AND user_id = ?',
      params: [patch.include_in_suggestions ? 1 : 0, id, access.userId],
    });
  }
  if (patch.log_visibility !== undefined) {
    stmts.push({
      sql: 'UPDATE list_members SET log_visibility = ? WHERE list_id = ? AND user_id = ?',
      params: [patch.log_visibility, id, access.userId],
    });
  }
  // Personal: only the viewer's own devices need to hear about it.
  stmts.push(
    changeStmt(ctx, {
      entity: 'list',
      entityId: id,
      listId: id,
      op: 'upsert',
      actor: { id: access.userId, kind: 'user' },
      visibleTo: access.userId,
    }),
  );
  await ctx.db.batch(stmts);
  return getList(ctx, access, id);
}

/** Soft delete (owner only): purged after DELETE_GRACE_DAYS, restorable until then. */
export async function deleteList(ctx: Ctx, access: Access, actor: Actor, id: string) {
  await requireListRole(ctx, access, id, 'owner');
  const others = await ctx.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM list_members m JOIN lists l ON l.id = m.list_id
      WHERE m.user_id = ? AND l.deleted_at IS NULL AND l.id != ?`,
    access.userId,
    id,
  );
  if ((others?.n ?? 0) === 0) throw conflict('last_list', 'You cannot delete your only list');
  await ctx.db.batch([
    { sql: 'UPDATE lists SET deleted_at = ? WHERE id = ?', params: [iso(ctx.clock.now()), id] },
    changeStmt(ctx, { entity: 'list', entityId: id, listId: id, op: 'delete', actor }),
  ]);
}

export async function deletedLists(ctx: Ctx, userId: string) {
  return ctx.db.all<{ id: string; name: string; deleted_at: string }>(
    `SELECT l.id, l.name, l.deleted_at FROM lists l
       JOIN list_members m ON m.list_id = l.id AND m.user_id = ? AND m.role = 'owner'
      WHERE l.deleted_at IS NOT NULL ORDER BY l.deleted_at DESC`,
    userId,
  );
}

export async function restoreList(ctx: Ctx, access: Access, actor: Actor, id: string) {
  const r = await ctx.db.batch([
    {
      sql: `UPDATE lists SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM list_members WHERE list_id = ? AND user_id = ? AND role = 'owner')`,
      params: [iso(ctx.clock.now()), id, id, access.userId],
    },
    changeStmt(
      ctx,
      { entity: 'list', entityId: id, listId: id, op: 'upsert', actor },
      { sql: 'EXISTS (SELECT 1 FROM lists WHERE id = ? AND deleted_at IS NULL)', params: [id] },
    ),
  ]);
  if (r[0]?.changes !== 1) throw notFound('list_not_found');
  return getList(ctx, access, id);
}

/** Cron: purge lists soft-deleted more than DELETE_GRACE_DAYS ago (cascades to items). */
export async function purgeDeletedLists(ctx: Ctx): Promise<number> {
  const cutoff = iso(ctx.clock.now() - ctx.config.DELETE_GRACE_DAYS * 86_400_000);
  const r = await ctx.db.run(
    'DELETE FROM lists WHERE deleted_at IS NOT NULL AND deleted_at < ?',
    cutoff,
  );
  return r.changes;
}
