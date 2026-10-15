// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Items (§3.2) and their single write path. REST routes, offline sync replay
 * (§6) and MCP tools (§8) all call `applyItemWrite`, so permissions,
 * validation, last-write-wins and the change log are enforced in one place.
 *
 * Last-write-wins per field: every field has a timestamp in `field_clock`
 * (epoch ms). A write carries a timestamp per field (offline: when the user
 * made the edit; online: now), clamped to min(client, server now) so a
 * client with a fast clock cannot win forever. A field is applied when its
 * timestamp is ≥ the stored one. Concurrent writers are serialised with a
 * compare-and-swap on `field_clock` (which carries a random revision).
 */
import { HttpError, badRequest, notFound } from '../../core/errors';
import { iso, type Stmt } from '../../core/ports';
import { ulid } from '../../core/ulid';
import {
  ITEM_FIELDS,
  type Item,
  type ItemField,
  type ItemFields,
  ItemFieldsSchema,
  type Status,
} from '../../shared/schemas/items';
import { type Actor, changeStmt } from '../data/changes';
import { type Access, requireListRole, restrictLists } from '../lists/access';
import { anonThreshold } from '../lists/service';
import type { Ctx } from '../types';

export const ID_RE = /^[0-9A-Za-z_-]{10,40}$/;

interface ItemRow {
  id: string;
  list_id: string;
  title: string;
  notes: string;
  status: Status;
  repeatable: number;
  duration: Item['duration'];
  setting: Item['setting'];
  cost: number | null;
  energy: Item['energy'];
  social: Item['social'];
  valid_from: string | null;
  valid_to: string | null;
  months: number | null;
  links: string;
  location: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  field_clock: string;
  tags: string;
  snoozed_until: string | null;
  last_suggested_at: string | null;
  my_last_done_on: string | null;
  anon_done: number;
  done_by: string;
  member_count: number;
  anon_count_min_members: number | null;
}

/** Every column the API exposes, plus the viewer's personal state and aggregates. */
const ITEM_SELECT = `
  SELECT i.id, i.list_id, i.title, i.notes, i.status, i.repeatable, i.duration, i.setting,
         i.cost, i.energy, i.social, i.valid_from, i.valid_to, i.months, i.links, i.location,
         i.created_by, i.created_at, i.updated_at, i.field_clock,
         (SELECT json_group_array(tag) FROM (SELECT tag FROM item_tags WHERE item_id = i.id ORDER BY tag)) AS tags,
         ss.snoozed_until, ss.last_suggested_at,
         (SELECT MAX(done_on) FROM item_log WHERE item_id = i.id AND user_id = ?1) AS my_last_done_on,
         (SELECT COUNT(DISTINCT user_id) FROM item_log
           WHERE item_id = i.id AND visibility IN ('anonymous', 'shared')) AS anon_done,
         (SELECT json_group_array(name) FROM (
            SELECT DISTINCT u.display_name AS name FROM item_log lg JOIN users u ON u.id = lg.user_id
             WHERE lg.item_id = i.id AND lg.visibility = 'shared' ORDER BY name)) AS done_by,
         (SELECT COUNT(*) FROM list_members WHERE list_id = i.list_id) AS member_count,
         l.anon_count_min_members
    FROM items i
    JOIN lists l ON l.id = i.list_id AND l.deleted_at IS NULL
    JOIN list_members m ON m.list_id = i.list_id AND m.user_id = ?1
    LEFT JOIN suggestion_state ss ON ss.item_id = i.id AND ss.user_id = ?1
   WHERE 1`;

function toItem(ctx: Ctx, r: ItemRow): Item {
  const threshold = anonThreshold(ctx, r.anon_count_min_members);
  return {
    id: r.id,
    list_id: r.list_id,
    title: r.title,
    notes: r.notes,
    status: r.status,
    repeatable: r.repeatable === 1,
    duration: r.duration,
    setting: r.setting,
    cost: r.cost,
    energy: r.energy,
    social: r.social,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    months: r.months,
    links: JSON.parse(r.links) as Item['links'],
    location: r.location ? (JSON.parse(r.location) as Item['location']) : null,
    tags: JSON.parse(r.tags) as string[],
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    done_for_me: r.my_last_done_on !== null,
    my_last_done_on: r.my_last_done_on,
    snoozed_until: r.snoozed_until,
    last_suggested_at: r.last_suggested_at,
    // Below the group-size threshold the count would identify people (§3.3).
    done_count: r.member_count >= threshold ? r.anon_done : null,
    done_by: r.member_count > 1 ? (JSON.parse(r.done_by) as string[]) : [],
  };
}

export interface ItemQuery {
  ids?: string[];
  list_id?: string;
  status?: Status[];
  q?: string;
  tag?: string[];
  /** Exclude items done (non-repeatable) by the viewer. */
  open_for_me?: boolean;
  limit?: number;
}

export async function queryItems(ctx: Ctx, access: Access, q: ItemQuery = {}): Promise<Item[]> {
  let sql = ITEM_SELECT;
  const params: (string | number)[] = [access.userId];
  const r = restrictLists('i', access);
  sql += r.sql;
  params.push(...r.params);
  if (q.ids) {
    if (!q.ids.length) return [];
    sql += ` AND i.id IN (${q.ids.map(() => '?').join(', ')})`;
    params.push(...q.ids);
  }
  if (q.list_id) {
    sql += ' AND i.list_id = ?';
    params.push(q.list_id);
  }
  if (q.status?.length) {
    sql += ` AND i.status IN (${q.status.map(() => '?').join(', ')})`;
    params.push(...q.status);
  }
  if (q.q) {
    // LIKE with escaped wildcards; lower() on both sides for case-insensitivity.
    const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    sql += ` AND (lower(i.title) LIKE ? ESCAPE '\\' OR lower(i.notes) LIKE ? ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag LIKE ? ESCAPE '\\'))`;
    params.push(like, like, like);
  }
  for (const tag of q.tag ?? []) {
    sql += ' AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)';
    params.push(tag.toLowerCase());
  }
  if (q.open_for_me) {
    sql += ` AND (i.repeatable = 1 OR NOT EXISTS
               (SELECT 1 FROM item_log lg WHERE lg.item_id = i.id AND lg.user_id = ?1))`;
  }
  sql += ' ORDER BY i.created_at DESC';
  if (q.limit) {
    sql += ' LIMIT ?';
    params.push(q.limit);
  }
  return (await ctx.db.all<ItemRow>(sql, ...params)).map((row) => toItem(ctx, row));
}

export async function getItem(ctx: Ctx, access: Access, id: string): Promise<Item> {
  const [item] = await queryItems(ctx, access, { ids: [id] });
  if (!item) throw notFound('item_not_found');
  return item;
}

// ── Writing ────────────────────────────────────────────────────────────

export type ItemWrite =
  | {
      kind: 'upsert';
      id?: string;
      fields: Partial<ItemFields>;
      /** Client time per field (epoch ms); missing fields use `ts` or now. */
      field_ts?: Partial<Record<ItemField, number>>;
      ts?: number;
    }
  | { kind: 'delete'; id: string };

type Clock = Record<string, number | string>;

/** Column values for the fields being written. */
function columnValue(field: ItemField, v: unknown): string | number | null {
  switch (field) {
    case 'repeatable':
      return v ? 1 : 0;
    case 'links':
      return JSON.stringify(v ?? []);
    case 'location':
      return v ? JSON.stringify(v) : null;
    case 'months':
      return v === 0 ? null : (v as number | null);
    default:
      return v as string | number | null;
  }
}

const DEFAULTS: Omit<ItemFields, 'list_id' | 'title'> = {
  notes: '',
  status: 'idea',
  repeatable: false,
  duration: null,
  setting: null,
  cost: null,
  energy: null,
  social: null,
  valid_from: null,
  valid_to: null,
  months: null,
  links: [],
  location: null,
  tags: [],
};

function checkWindow(f: Partial<ItemFields>) {
  if (f.valid_from && f.valid_to && f.valid_from > f.valid_to) {
    throw badRequest('bad_window', 'valid_from must not be after valid_to');
  }
}

/** Tag rows for an item, replacing the old set. */
function tagStmts(itemId: string, tags: string[], gate: { sql: string; params: string[] }): Stmt[] {
  const unique = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  return [
    {
      sql: `DELETE FROM item_tags WHERE item_id = ? AND ${gate.sql}`,
      params: [itemId, ...gate.params],
    },
    ...unique.map((t) => ({
      sql: `INSERT OR IGNORE INTO item_tags (item_id, tag) SELECT ?, ? WHERE ${gate.sql}`,
      params: [itemId, t, ...gate.params],
    })),
  ];
}

export interface WriteResult {
  id: string;
  /** For upserts: the fields that lost to a newer write (LWW). */
  rejected: ItemField[];
  deleted?: boolean;
}

/**
 * Apply one item write. `access` limits which lists may be touched (OAuth
 * list restrictions), `actor` is recorded in the change log.
 */
export async function applyItemWrite(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  w: ItemWrite,
): Promise<WriteResult> {
  if (w.kind === 'delete') return deleteItem(ctx, access, actor, w.id);
  const now = ctx.clock.now();
  const parsed = ItemFieldsSchema.partial().safeParse(w.fields);
  if (!parsed.success) {
    throw badRequest('validation', 'Invalid item', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const fields = parsed.data;
  if (w.id !== undefined && !ID_RE.test(w.id)) throw badRequest('bad_id', 'Invalid item id');
  const tsFor = (f: ItemField) => Math.min(w.field_ts?.[f] ?? w.ts ?? now, now);

  const current = w.id
    ? await ctx.db.first<ItemRow>('SELECT * FROM items WHERE id = ?', w.id)
    : null;
  if (!current) return createItem(ctx, access, actor, w.id ?? ulid(now), fields, tsFor);
  return updateItem(ctx, access, actor, current, fields, tsFor);
}

async function createItem(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  id: string,
  fields: Partial<ItemFields>,
  tsFor: (f: ItemField) => number,
): Promise<WriteResult> {
  if (!fields.list_id || !fields.title) {
    throw badRequest('validation', 'list_id and title are required for a new item');
  }
  await requireListRole(ctx, access, fields.list_id, 'editor');
  const all = { ...DEFAULTS, ...fields } as ItemFields;
  checkWindow(all);
  const now = iso(ctx.clock.now());
  const clock: Clock = { _rev: ulid() };
  for (const f of ITEM_FIELDS) clock[f] = tsFor(f);
  const cols = ITEM_FIELDS.filter((f) => f !== 'tags');
  const gate = {
    sql: 'EXISTS (SELECT 1 FROM items WHERE id = ? AND field_clock = ?)',
    params: [id, JSON.stringify(clock)],
  };
  await ctx.db.batch([
    {
      sql: `INSERT OR IGNORE INTO items (id, ${cols.join(', ')}, created_by, created_at, updated_at, field_clock)
            VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
      params: [
        id,
        ...cols.map((f) => columnValue(f, all[f])),
        access.userId,
        now,
        now,
        JSON.stringify(clock),
      ],
    },
    ...tagStmts(id, all.tags, gate),
    changeStmt(
      ctx,
      { entity: 'item', entityId: id, listId: all.list_id, op: 'upsert', actor },
      gate,
    ),
  ]);
  if (
    !(await ctx.db.first(
      'SELECT 1 FROM items WHERE id = ? AND field_clock = ?',
      id,
      JSON.stringify(clock),
    ))
  ) {
    // Lost a race with a concurrent create of the same id: retry as an update.
    throw new HttpError(409, 'conflict', 'The item changed while saving; try again');
  }
  return { id, rejected: [] };
}

async function updateItem(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  current: ItemRow,
  fields: Partial<ItemFields>,
  tsFor: (f: ItemField) => number,
): Promise<WriteResult> {
  await requireListRole(ctx, access, current.list_id, 'editor');
  const clock = JSON.parse(current.field_clock) as Clock;
  const apply: Partial<ItemFields> = {};
  const rejected: ItemField[] = [];
  for (const f of Object.keys(fields) as ItemField[]) {
    if (fields[f] === undefined) continue;
    const ts = tsFor(f);
    if (ts >= Number(clock[f] ?? 0)) {
      (apply as Record<string, unknown>)[f] = fields[f];
      clock[f] = ts;
    } else rejected.push(f);
  }
  const moving = apply.list_id !== undefined && apply.list_id !== current.list_id;
  if (moving) await requireListRole(ctx, access, apply.list_id!, 'editor');
  if (!Object.keys(apply).length) return { id: current.id, rejected };
  checkWindow({
    valid_from: apply.valid_from !== undefined ? apply.valid_from : current.valid_from,
    valid_to: apply.valid_to !== undefined ? apply.valid_to : current.valid_to,
  });

  const oldClock = current.field_clock;
  clock._rev = ulid();
  const newClock = JSON.stringify(clock);
  const cols = (Object.keys(apply) as ItemField[]).filter((f) => f !== 'tags');
  const gate = {
    sql: 'EXISTS (SELECT 1 FROM items WHERE id = ? AND field_clock = ?)',
    params: [current.id, newClock],
  };
  const listId = apply.list_id ?? current.list_id;
  const stmts: Stmt[] = [
    {
      sql: `UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')}${cols.length ? ', ' : ''}
              updated_at = ?, field_clock = ? WHERE id = ? AND field_clock = ?`,
      params: [
        ...cols.map((f) => columnValue(f, apply[f])),
        iso(ctx.clock.now()),
        newClock,
        current.id,
        oldClock,
      ],
    },
  ];
  if (apply.tags) stmts.push(...tagStmts(current.id, apply.tags, gate));
  if (moving) {
    // Members of the old list lose sight of it: a tombstone for them.
    stmts.push(
      changeStmt(
        ctx,
        { entity: 'item', entityId: current.id, listId: current.list_id, op: 'delete', actor },
        gate,
      ),
    );
    // Personal suggestion state stays; log entries move with the item.
  }
  stmts.push(
    changeStmt(ctx, { entity: 'item', entityId: current.id, listId, op: 'upsert', actor }, gate),
  );
  const [upd] = await ctx.db.batch(stmts);
  if (upd?.changes !== 1) {
    throw new HttpError(409, 'conflict', 'The item changed while saving; try again');
  }
  return { id: current.id, rejected };
}

async function deleteItem(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  id: string,
): Promise<WriteResult> {
  const row = await ctx.db.first<{ list_id: string }>('SELECT list_id FROM items WHERE id = ?', id);
  // Deleting something already gone is fine (idempotent replays).
  if (!row) return { id, rejected: [], deleted: true };
  await requireListRole(ctx, access, row.list_id, 'editor');
  await ctx.db.batch([
    { sql: 'DELETE FROM items WHERE id = ?', params: [id] },
    changeStmt(ctx, { entity: 'item', entityId: id, listId: row.list_id, op: 'delete', actor }),
  ]);
  return { id, rejected: [], deleted: true };
}

/** Retry wrapper: a lost compare-and-swap re-reads and tries again. */
export async function writeItem(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  w: ItemWrite,
): Promise<WriteResult> {
  for (let i = 0; ; i++) {
    try {
      return await applyItemWrite(ctx, access, actor, w);
    } catch (err) {
      if (i < 3 && err instanceof HttpError && err.code === 'conflict') continue;
      throw err;
    }
  }
}

// ── Personal suggestion state (§4.1 actions) ───────────────────────────

export async function setSuggestionState(
  ctx: Ctx,
  access: Access,
  itemId: string,
  patch: { snoozed_until?: string | null; last_suggested_at?: string | null },
): Promise<void> {
  const item = await getItem(ctx, access, itemId);
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  if (!cols.length) return;
  await ctx.db.batch([
    {
      sql: `INSERT INTO suggestion_state (user_id, item_id, ${cols.join(', ')})
            VALUES (?, ?, ${cols.map(() => '?').join(', ')})
            ON CONFLICT(user_id, item_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
      params: [access.userId, itemId, ...cols.map((c) => patch[c] ?? null)],
    },
    // Only the viewer's own devices need the update.
    changeStmt(ctx, {
      entity: 'item',
      entityId: itemId,
      listId: item.list_id,
      op: 'upsert',
      actor: { id: access.userId, kind: 'user' },
      visibleTo: access.userId,
    }),
  ]);
}

/** The viewer's tag vocabulary with counts, across the lists they can see. */
export async function tagVocabulary(ctx: Ctx, access: Access) {
  const r = restrictLists('i', access);
  return ctx.db.all<{ tag: string; count: number }>(
    `SELECT t.tag, COUNT(*) AS count FROM item_tags t
       JOIN items i ON i.id = t.item_id
       JOIN lists l ON l.id = i.list_id AND l.deleted_at IS NULL
       JOIN list_members m ON m.list_id = i.list_id AND m.user_id = ?
      WHERE 1 ${r.sql}
      GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 500`,
    access.userId,
    ...r.params,
  );
}
