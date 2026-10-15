// SPDX-License-Identifier: AGPL-3.0-or-later
/** GET /api/sync (pull changes since a cursor) and POST /api/sync (replay queued ops), §6. */
import { createRoute, z } from '@hono/zod-openapi';
import { VISIBILITIES } from '../../shared/schemas/items';
import { sessionAccess } from '../access';
import { body, json } from '../http';
import type { Module, Router } from '../types';
import { type Op, pruneSyncTables, pull, push } from './service';

const Any = z.record(z.string(), z.unknown());
const OpId = z.string().min(8).max(64);
const Id = z.string().min(1).max(40);

const OpSchema = z.discriminatedUnion('kind', [
  z.object({
    op_id: OpId,
    kind: z.literal('item.upsert'),
    id: Id,
    fields: z.record(z.string(), z.unknown()),
    field_ts: z.record(z.string(), z.number()).optional(),
    ts: z.number().optional(),
  }),
  z.object({ op_id: OpId, kind: z.literal('item.delete'), id: Id }),
  z.object({
    op_id: OpId,
    kind: z.literal('item.snooze'),
    id: Id,
    until: z.iso.datetime().nullable(),
  }),
  z.object({ op_id: OpId, kind: z.literal('item.seen'), id: Id, at: z.number() }),
  z.object({
    op_id: OpId,
    kind: z.literal('log.create'),
    id: Id,
    item_id: Id,
    done_on: z.iso.date(),
    note: z.string().max(5000).optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    visibility: z.enum(VISIBILITIES).optional(),
  }),
  z.object({
    op_id: OpId,
    kind: z.literal('log.update'),
    id: Id,
    patch: z.object({
      done_on: z.iso.date().optional(),
      note: z.string().max(5000).optional(),
      rating: z.number().int().min(1).max(5).nullable().optional(),
      visibility: z.enum(VISIBILITIES).optional(),
    }),
  }),
  z.object({ op_id: OpId, kind: z.literal('log.delete'), id: Id }),
  z.object({
    op_id: OpId,
    kind: z.literal('list.create'),
    id: Id,
    name: z.string().trim().min(1).max(100),
  }),
  z.object({
    op_id: OpId,
    kind: z.literal('list.update'),
    id: Id,
    name: z.string().trim().min(1).max(100),
  }),
  z.object({
    op_id: OpId,
    kind: z.literal('list.membership'),
    id: Id,
    include_in_suggestions: z.boolean().optional(),
    log_visibility: z.enum(VISIBILITIES).optional(),
  }),
]);

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['sync'],
      request: { query: z.object({ since: z.coerce.number().int().min(0).default(0) }) },
      responses: { 200: json(Any) },
    }),
    async (c) =>
      c.json(await pull(c.env.ctx, sessionAccess(c).access, c.req.valid('query').since), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['sync'],
      request: body(z.object({ ops: z.array(OpSchema).max(200) })),
      responses: { 200: json(z.object({ results: z.array(Any) })) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      const results = await push(c.env.ctx, access, actor, c.req.valid('json').ops as Op[]);
      return c.json({ results }, 200);
    },
  );
}

export const syncModule: Module = { name: 'sync', routes, cron: pruneSyncTables };
