// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Download my data" (§7): a zip with
 * - someday-export.json (`someday-export/v1`): profile and settings (no
 *   credentials), every list the user can see with its items, and only the
 *   user's own log entries; lists owned by others carry `shared_from`,
 * - markdown/<list-slug>.md: one readable file per list,
 * - README.txt.
 * Generated synchronously: the data of one person is small.
 */
import { strToU8, zipSync } from 'fflate';
import { iso } from '../../core/ports';
import { EXPORT_SCHEMA, type Export, type ExportList } from '../../shared/schemas/export';
import { queryItems } from '../items/service';
import type { Access } from '../lists/access';
import { getLists } from '../lists/service';
import { userSettings } from '../notices/service';
import type { Ctx } from '../types';

export async function buildExport(ctx: Ctx, access: Access): Promise<Export> {
  const user = await ctx.db.first<{ display_name: string; created_at: string }>(
    'SELECT display_name, created_at FROM users WHERE id = ?',
    access.userId,
  );
  const lists = await getLists(ctx, access);
  const items = await queryItems(ctx, access, {});
  const logs = await ctx.db.all<{
    item_id: string;
    done_on: string;
    note: string;
    rating: number | null;
    visibility: 'private' | 'anonymous' | 'shared';
    created_at: string;
  }>(
    `SELECT item_id, done_on, note, rating, visibility, created_at FROM item_log
      WHERE user_id = ? ORDER BY done_on, created_at`,
    access.userId,
  );
  const logByItem = new Map<string, typeof logs>();
  for (const l of logs) logByItem.set(l.item_id, [...(logByItem.get(l.item_id) ?? []), l]);

  const out: ExportList[] = lists.map((l) => ({
    id: l.id,
    name: l.name,
    role: l.role,
    created_at: l.created_at,
    shared_from:
      l.role === 'owner'
        ? null
        : { owner: l.members.find((m) => m.role === 'owner')?.display_name ?? '' },
    items: items
      .filter((i) => i.list_id === l.id)
      .map((i) => ({
        id: i.id,
        title: i.title,
        notes: i.notes,
        status: i.status,
        repeatable: i.repeatable,
        duration: i.duration,
        setting: i.setting,
        cost: i.cost,
        energy: i.energy,
        social: i.social,
        valid_from: i.valid_from,
        valid_to: i.valid_to,
        months: i.months,
        links: i.links,
        location: i.location,
        tags: i.tags,
        created_at: i.created_at,
        updated_at: i.updated_at,
        log: (logByItem.get(i.id) ?? []).map(({ item_id: _i, ...e }) => e),
      })),
  }));

  return {
    schema: EXPORT_SCHEMA,
    exported_at: iso(ctx.clock.now()),
    source: { origin: ctx.config.PUBLIC_ORIGIN, version: ctx.config.APP_VERSION },
    user: {
      display_name: user?.display_name ?? '',
      created_at: user?.created_at ?? '',
      settings: { ...(await userSettings(ctx, access.userId)) },
    },
    lists: out,
  };
}

/** "Things to do with Kari" → "things-to-do-with-kari" (ASCII, unique). */
export function slugify(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/æ/gi, 'ae')
      .replace(/ø/gi, 'o')
      .replace(/å/gi, 'a')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'list';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

const STATUS_ORDER = ['planned', 'idea', 'done', 'archived'] as const;
const STATUS_HEADING = {
  planned: 'Planned',
  idea: 'Ideas',
  done: 'Done',
  archived: 'Dropped',
} as const;

export function listMarkdown(list: ExportList): string {
  const lines = [`# ${list.name}`, ''];
  if (list.shared_from) lines.push(`Shared list, owned by ${list.shared_from.owner}.`, '');
  for (const status of STATUS_ORDER) {
    const items = list.items.filter((i) => i.status === status);
    if (!items.length) continue;
    lines.push(`## ${STATUS_HEADING[status]}`, '');
    for (const i of items) {
      const facts = [
        i.duration,
        i.setting,
        i.cost !== null ? `cost ${i.cost}/3` : null,
        i.energy ? `${i.energy} energy` : null,
        i.social,
        i.valid_from ? `from ${i.valid_from}` : null,
        i.valid_to ? `until ${i.valid_to}` : null,
        i.repeatable ? 'repeatable' : null,
        ...i.tags.map((t) => `#${t}`),
      ].filter(Boolean);
      lines.push(`- **${i.title}**${facts.length ? ` (${facts.join(', ')})` : ''}`);
      for (const note of i.notes.split('\n').filter((l) => l.trim())) lines.push(`  ${note}`);
      for (const l of i.links) lines.push(`  - [${l.label || l.url}](${l.url})`);
      if (i.location) lines.push(`  - Place: ${i.location.label}`);
      for (const e of i.log) {
        const stars = e.rating ? ` ${'★'.repeat(e.rating)}` : '';
        lines.push(
          `  - Done ${e.done_on}${stars}${e.note ? `: ${e.note.replace(/\n/g, ' ')}` : ''}`,
        );
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const README = `Someday data export
===================

someday-export.json
  Everything in machine-readable form, schema "someday-export/v1"
  (JSON Schema: docs/someday-export-v1.schema.json in the source code).
  Your profile and settings, every list you could see with its ideas, and
  your own "done" log entries with their visibility. Lists owned by someone
  else are marked "shared_from". Other members' log entries are never
  included: they are their data. No passkeys or other credentials.

markdown/
  One readable file per list, grouped by status, with your log entries.

To move to another Someday instance, use Settings -> Your data -> Import
there and pick this zip file (or someday-export.json).
`;

export async function buildExportZip(ctx: Ctx, access: Access): Promise<Uint8Array<ArrayBuffer>> {
  const data = await buildExport(ctx, access);
  const taken = new Set<string>();
  const files: Record<string, Uint8Array> = {
    'someday-export.json': strToU8(JSON.stringify(data, null, 2)),
    'README.txt': strToU8(README),
  };
  for (const l of data.lists) {
    files[`markdown/${slugify(l.name, taken)}.md`] = strToU8(listMarkdown(l));
  }
  return zipSync(files, { level: 6 });
}
