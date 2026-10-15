// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MCP tools (§8.2). Each tool has a scope, a zod input schema (published as
 * JSON Schema) and returns compact JSON plus a short text summary. Writes go
 * through the same services as the app, recorded in `changes` with the OAuth
 * client as actor ("via <client name>").
 */
import { z } from 'zod';
import { HttpError } from '../../core/errors';
import { iso } from '../../core/ports';
import { matchFilters, type SuggestFilters } from '../../core/suggest';
import { dateOf } from '../../core/time';
import {
  DURATIONS,
  ENERGIES,
  type Item,
  ItemFieldsSchema,
  STATUSES,
  VISIBILITIES,
} from '../../shared/schemas/items';
import type { Actor } from '../data/changes';
import { itemLog, logDone } from '../items/log';
import { getItem, queryItems, writeItem } from '../items/service';
import type { Access } from '../lists/access';
import { getLists } from '../lists/service';
import { userSettings } from '../notices/service';
import { sendAgentNotification } from '../notify/agent';
import { suggestFor } from '../suggest/service';
import type { Ctx, Scope } from '../types';

export interface ToolContext {
  ctx: Ctx;
  access: Access;
  actor: Actor;
}

export interface ToolResult {
  text: string;
  data: unknown;
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: S;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run(t: ToolContext, args: z.output<S>): Promise<ToolResult>;
}

const filterFields = {
  max_duration: z.enum(DURATIONS).optional().describe('Longest acceptable duration'),
  setting: z.enum(['indoor', 'outdoor']).optional(),
  max_cost: z.number().int().min(0).max(3).optional().describe('0 = free … 3 = expensive'),
  energy: z.enum(ENERGIES).optional().describe('Energy available'),
  social: z.enum(['solo', 'together']).optional(),
};

/** Compact item JSON: unset context fields are left out. */
export function compactItem(i: Item) {
  const out: Record<string, unknown> = {
    id: i.id,
    list_id: i.list_id,
    title: i.title,
    status: i.status,
  };
  if (i.notes) out.notes = i.notes;
  for (const k of [
    'duration',
    'setting',
    'cost',
    'energy',
    'social',
    'valid_from',
    'valid_to',
    'months',
    'location',
  ] as const) {
    if (i[k] !== null && i[k] !== undefined) out[k] = i[k];
  }
  if (i.repeatable) out.repeatable = true;
  if (i.tags.length) out.tags = i.tags;
  if (i.links.length) out.links = i.links;
  if (i.done_for_me) out.done_for_me = true;
  if (i.my_last_done_on) out.my_last_done_on = i.my_last_done_on;
  if (i.done_count !== null) out.done_count = i.done_count;
  if (i.done_by.length) out.done_by = i.done_by;
  if (i.snoozed_until && Date.parse(i.snoozed_until) > Date.now())
    out.snoozed_until = i.snoozed_until;
  if (i.hidden_at) out.hidden_for_me = true;
  if (i.hearted_by.length) out.hearted_by = i.hearted_by;
  return out;
}

const line = (i: Item) => `- ${i.title}${i.status === 'idea' ? '' : ` (${i.status})`} [${i.id}]`;

function def<S extends z.ZodType>(d: ToolDef<S>) {
  return d;
}

export const TOOLS = [
  def({
    name: 'list_lists',
    title: 'List lists',
    description: 'The lists of ideas this connection can see, with your role and member count.',
    scope: 'someday:read',
    readOnly: true,
    input: z.object({}),
    async run({ ctx, access }) {
      const lists = await getLists(ctx, access);
      return {
        text: lists.length
          ? lists
              .map(
                (l) =>
                  `- ${l.name} (${l.role}, ${l.member_count} member${l.member_count === 1 ? '' : 's'}) [${l.id}]`,
              )
              .join('\n')
          : 'No lists.',
        data: {
          lists: lists.map((l) => ({
            id: l.id,
            name: l.name,
            role: l.role,
            member_count: l.member_count,
            include_in_suggestions: l.include_in_suggestions,
          })),
        },
      };
    },
  }),

  def({
    name: 'search_items',
    title: 'Search ideas',
    description:
      'Search ideas by text, status, tags, list and context (unset item fields match any filter).',
    scope: 'someday:read',
    readOnly: true,
    input: z.object({
      text: z.string().max(200).optional().describe('Matches title, notes and tags'),
      status: z.array(z.enum(STATUSES)).optional(),
      tags: z.array(z.string().max(50)).optional().describe('All of these tags'),
      list_id: z.string().optional(),
      open_for_me: z.boolean().optional().describe('Leave out ideas you have already done'),
      ...filterFields,
      limit: z.number().int().min(1).max(200).default(50),
    }),
    async run({ ctx, access }, a) {
      const items = (
        await queryItems(ctx, access, {
          q: a.text,
          status: a.status,
          tag: a.tags,
          list_id: a.list_id,
          open_for_me: a.open_for_me,
        })
      )
        .filter((i) => matchFilters(i, a as SuggestFilters) !== null)
        .slice(0, a.limit);
      return {
        text: items.length
          ? `${items.length} idea(s):\n${items.map(line).join('\n')}`
          : 'No ideas match.',
        data: { items: items.map(compactItem) },
      };
    },
  }),

  def({
    name: 'get_item',
    title: 'Get an idea',
    description: 'One idea with its log: your own entries and others’ shared ones.',
    scope: 'someday:read',
    readOnly: true,
    input: z.object({ id: z.string() }),
    async run({ ctx, access }, a) {
      const item = await getItem(ctx, access, a.id);
      const log = await itemLog(ctx, access, a.id);
      return {
        text: `${item.title} (${item.status})${item.notes ? `\n${item.notes}` : ''}${log.length ? `\nDone ${log.length} time(s), last ${log[0]!.done_on}.` : ''}`,
        data: {
          item: compactItem(item),
          log: log.map((e) => ({
            id: e.id,
            done_on: e.done_on,
            note: e.note || undefined,
            rating: e.rating ?? undefined,
            visibility: e.visibility,
            by: e.mine ? 'me' : e.user_name,
          })),
        },
      };
    },
  }),

  def({
    name: 'suggest',
    title: 'Give me something to do',
    description:
      'A weighted random suggestion that fits the filters, with human-readable reasons. Pass exclude to get another one.',
    scope: 'someday:read',
    readOnly: false,
    idempotent: false,
    destructive: false,
    input: z.object({
      ...filterFields,
      list_ids: z.array(z.string()).optional(),
      tags_include: z.array(z.string()).optional(),
      tags_exclude: z.array(z.string()).optional(),
      exclude: z.array(z.string()).max(500).optional().describe('Item IDs already suggested'),
    }),
    async run({ ctx, access }, a) {
      const { exclude, ...filters } = a;
      const r = await suggestFor(ctx, access, filters, { exclude });
      if (!r.suggestion) return { text: 'Nothing fits right now.', data: { suggestion: null } };
      const s = r.suggestion;
      return {
        text: `${s.item.title}\n${s.reason_texts.map((x) => `- ${x}`).join('\n')}`,
        data: {
          suggestion: { item: compactItem(s.item), reasons: s.reason_texts, score: s.score },
        },
      };
    },
  }),

  def({
    name: 'create_item',
    title: 'Add an idea',
    description: 'Add an idea to a list (default: the first list you own). Only title is required.',
    scope: 'someday:write',
    readOnly: false,
    destructive: false,
    input: ItemFieldsSchema.partial().extend({
      title: ItemFieldsSchema.shape.title,
      list_id: z.string().optional(),
    }),
    async run({ ctx, access, actor }, a) {
      let listId = a.list_id;
      if (!listId) {
        const lists = await getLists(ctx, access);
        listId = (lists.find((l) => l.role === 'owner') ?? lists.find((l) => l.role === 'editor'))
          ?.id;
        if (!listId) throw new HttpError(404, 'list_not_found', 'No list to add to');
      }
      const r = await writeItem(ctx, access, actor, {
        kind: 'upsert',
        fields: { ...a, list_id: listId },
      });
      const item = await getItem(ctx, access, r.id);
      return { text: `Added “${item.title}” [${item.id}]`, data: { item: compactItem(item) } };
    },
  }),

  def({
    name: 'update_item',
    title: 'Update an idea',
    description: 'Change some fields of an idea; fields not given stay as they are.',
    scope: 'someday:write',
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: ItemFieldsSchema.partial().extend({ id: z.string() }),
    async run({ ctx, access, actor }, a) {
      const { id, ...fields } = a;
      await getItem(ctx, access, id);
      await writeItem(ctx, access, actor, { kind: 'upsert', id, fields });
      const item = await getItem(ctx, access, id);
      return { text: `Updated “${item.title}”`, data: { item: compactItem(item) } };
    },
  }),

  def({
    name: 'set_status',
    title: 'Set status',
    description:
      'Set an idea’s status for everyone on the list: idea, planned, done, archived (dropped). To record that you did it, use log_done.',
    scope: 'someday:write',
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: z.object({ id: z.string(), status: z.enum(STATUSES) }),
    async run({ ctx, access, actor }, a) {
      await getItem(ctx, access, a.id);
      await writeItem(ctx, access, actor, {
        kind: 'upsert',
        id: a.id,
        fields: { status: a.status },
      });
      const item = await getItem(ctx, access, a.id);
      return { text: `“${item.title}” is now ${item.status}`, data: { item: compactItem(item) } };
    },
  }),

  def({
    name: 'log_done',
    title: 'Log as done',
    description:
      'Record that you did an idea. Visibility on shared lists: private (default, only you), anonymous (counted, not named), shared (everyone sees it).',
    scope: 'someday:write',
    readOnly: false,
    destructive: false,
    input: z.object({
      item_id: z.string(),
      done_on: z.iso.date().optional().describe('Defaults to today in your time zone'),
      note: z.string().max(5000).optional(),
      rating: z.number().int().min(1).max(5).optional(),
      visibility: z.enum(VISIBILITIES).default('private'),
    }),
    async run({ ctx, access, actor }, a) {
      const tz = (await userSettings(ctx, access.userId)).timezone;
      const entry = await logDone(ctx, access, actor, a.item_id, {
        done_on: a.done_on ?? dateOf(ctx.clock.now(), tz),
        note: a.note ?? '',
        rating: a.rating ?? null,
        visibility: a.visibility,
      });
      const item = await getItem(ctx, access, a.item_id);
      return {
        text: `Logged “${item.title}” as done on ${entry.done_on} (${entry.visibility})`,
        data: {
          entry: { id: entry.id, done_on: entry.done_on, visibility: entry.visibility },
          item: compactItem(item),
        },
      };
    },
  }),

  def({
    name: 'send_notification',
    title: 'Send a notification',
    description:
      'Send a push notification to the user’s devices. Respects their quiet hours (then it is delivered later) and a daily limit.',
    scope: 'someday:notify',
    readOnly: false,
    destructive: false,
    input: z.object({
      title: z.string().trim().min(1).max(100),
      body: z.string().trim().min(1).max(300),
      item_id: z.string().optional().describe('Opens this idea when tapped'),
    }),
    async run({ ctx, access }, a) {
      if (a.item_id) await getItem(ctx, access, a.item_id);
      const status = await sendAgentNotification(ctx, access.userId, {
        title: a.title,
        body: a.body,
        itemId: a.item_id ?? null,
      });
      const text = {
        sent: 'Sent.',
        deferred: 'Quiet hours: it will be delivered when they end.',
        disabled: 'Not sent: the user has turned off notifications from connected apps.',
        limit: 'Not sent: the daily limit for this kind of notification is reached.',
      }[status];
      return { text, data: { status, at: iso(ctx.clock.now()) } };
    },
  }),
] as const;

export type Tool = (typeof TOOLS)[number];

/** Tool descriptions for tools/list, in a deterministic order. */
export function toolList() {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    return {
      name: t.name,
      title: t.title,
      description: `${t.description} Requires the ${t.scope} scope.`,
      inputSchema: { ...schema, type: 'object' },
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly,
        ...(t.readOnly
          ? {}
          : { destructiveHint: t.destructive ?? false, idempotentHint: t.idempotent ?? false }),
        openWorldHint: false,
      },
    };
  });
}
