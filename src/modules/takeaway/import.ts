// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Import (§7): `someday-export/v1`, as the zip from "Download my data" or the
 * bare JSON. Modes: into new lists (default), or merged into one existing
 * list the user can edit. Every ID is remapped. A dry run returns the counts
 * without writing anything. This is also the way to move between instances.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { HttpError, badRequest } from '../../core/errors';
import { iso, type Stmt } from '../../core/ports';
import { ulid } from '../../core/ulid';
import { type Export, ExportSchema } from '../../shared/schemas/export';
import { ITEM_FIELDS } from '../../shared/schemas/items';
import { type Actor, changeStmt } from '../data/changes';
import { type Access, requireListRole } from '../lists/access';
import { anonThreshold } from '../lists/service';
import type { Ctx } from '../types';

export const MAX_IMPORT_ITEMS = 5000;
const BATCH = 100;

/** Parse an upload: a zip containing someday-export.json, or the JSON itself. */
export function parseUpload(bytes: Uint8Array): Export {
  let text: string;
  // "PK\x03\x04": a zip archive.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (f) => f.name.endsWith('someday-export.json') });
    } catch {
      throw badRequest('bad_zip', 'This is not a readable zip file');
    }
    const json = Object.values(files)[0];
    if (!json) throw badRequest('no_export', 'someday-export.json is missing from the zip');
    text = strFromU8(json);
  } else {
    text = new TextDecoder().decode(bytes);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest('bad_json', 'This is not valid JSON');
  }
  const parsed = ExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('bad_export', 'This is not a someday-export/v1 file', {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

export interface ImportSummary {
  lists: number;
  items: number;
  log_entries: number;
  tags: number;
  dry_run: boolean;
  list_ids: string[];
}

export async function importData(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  data: Export,
  opts: { mode: 'new' | 'merge'; list_id?: string; dry_run: boolean },
): Promise<ImportSummary> {
  const items = data.lists.flatMap((l) => l.items);
  if (items.length > MAX_IMPORT_ITEMS) {
    throw new HttpError(413, 'too_large', `At most ${MAX_IMPORT_ITEMS} ideas per import`);
  }
  let target: { id: string; members: number; threshold: number } | null = null;
  if (opts.mode === 'merge') {
    if (!opts.list_id) throw badRequest('list_required', 'Choose the list to merge into');
    await requireListRole(ctx, access, opts.list_id, 'editor');
    const row = await ctx.db.first<{ n: number; t: number | null }>(
      `SELECT (SELECT COUNT(*) FROM list_members WHERE list_id = ?1) AS n,
              (SELECT anon_count_min_members FROM lists WHERE id = ?1) AS t`,
      opts.list_id,
    );
    target = {
      id: opts.list_id,
      members: row?.n ?? 1,
      threshold: anonThreshold(ctx, row?.t ?? null),
    };
  }
  const summary: ImportSummary = {
    lists: opts.mode === 'new' ? data.lists.length : 0,
    items: items.length,
    log_entries: items.reduce((n, i) => n + i.log.length, 0),
    tags: new Set(items.flatMap((i) => i.tags)).size,
    dry_run: opts.dry_run,
    list_ids: target ? [target.id] : [],
  };
  if (opts.dry_run) return summary;

  const now = ctx.clock.now();
  const stamp = iso(now);
  const stmts: Stmt[] = [];
  for (const l of data.lists) {
    let listId: string;
    let members = 1;
    let threshold = Number.POSITIVE_INFINITY;
    if (target) {
      listId = target.id;
      members = target.members;
      threshold = target.threshold;
    } else {
      listId = ulid(now);
      summary.list_ids.push(listId);
      stmts.push(
        {
          sql: 'INSERT INTO lists (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          params: [listId, l.name, access.userId, stamp, stamp],
        },
        {
          sql: "INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
          params: [listId, access.userId, stamp],
        },
        changeStmt(ctx, { entity: 'list', entityId: listId, listId, op: 'upsert', actor }),
      );
    }
    for (const i of l.items) {
      const id = ulid(now);
      const clock: Record<string, number | string> = { _rev: ulid(now) };
      for (const f of ITEM_FIELDS) clock[f] = now;
      stmts.push({
        sql: `INSERT INTO items (id, list_id, title, notes, status, repeatable, duration, setting, cost,
                energy, social, valid_from, valid_to, months, links, location, created_by, created_at,
                updated_at, field_clock)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          listId,
          i.title,
          i.notes,
          i.status,
          i.repeatable ? 1 : 0,
          i.duration,
          i.setting,
          i.cost,
          i.energy,
          i.social,
          i.valid_from,
          i.valid_to,
          i.months || null,
          JSON.stringify(i.links),
          i.location ? JSON.stringify(i.location) : null,
          access.userId,
          i.created_at,
          stamp,
          JSON.stringify(clock),
        ],
      });
      for (const tag of new Set(i.tags)) {
        stmts.push({
          sql: 'INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)',
          params: [id, tag],
        });
      }
      for (const e of i.log) {
        // Keep the visibility where it still makes sense on the target list.
        const visibility =
          members <= 1
            ? 'private'
            : e.visibility === 'anonymous' && members < threshold
              ? 'private'
              : e.visibility;
        const logId = ulid(now);
        stmts.push({
          sql: `INSERT INTO item_log (id, item_id, user_id, done_on, note, rating, visibility,
                    created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            logId,
            id,
            access.userId,
            e.done_on,
            e.note,
            e.rating,
            visibility,
            e.created_at,
            stamp,
          ],
        });
        // Synced devices must learn about the entry too (shared ones concern everyone).
        stmts.push(
          changeStmt(ctx, {
            entity: 'log',
            entityId: logId,
            listId,
            op: 'upsert',
            actor,
            visibleTo: visibility === 'shared' ? null : access.userId,
          }),
        );
      }
      stmts.push(changeStmt(ctx, { entity: 'item', entityId: id, listId, op: 'upsert', actor }));
    }
  }
  // Batches of limited size; each list's rows land in order.
  for (let i = 0; i < stmts.length; i += BATCH) await ctx.db.batch(stmts.slice(i, i + BATCH));
  return summary;
}
