// SPDX-License-Identifier: AGPL-3.0-or-later
/** /api/items (CRUD, status, done log), /api/log/{id} (edit/undo), /api/tags. */
import { createRoute, z } from '@hono/zod-openapi';
import {
  ItemCreateSchema,
  ItemPatchSchema,
  LogInputSchema,
  LogPatchSchema,
  STATUSES,
} from '../../shared/schemas/items';
import { sessionAccess } from '../access';
import { body, json } from '../http';
import type { Module, Router } from '../types';
import { deleteLog, itemLog, logDone, updateLog } from './log';
import { getItem, queryItems, tagVocabulary, writeItem } from './service';

const Any = z.record(z.string(), z.unknown());
const Id = z.object({ id: z.string() });
const Ok = z.object({ ok: z.literal(true) });

const csv = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').filter(Boolean) : undefined));

function itemRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['items'],
      request: {
        query: z.object({
          list_id: z.string().optional(),
          status: csv.pipe(z.array(z.enum(STATUSES)).optional()),
          q: z.string().max(200).optional(),
          tag: csv,
          open_for_me: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        }),
      },
      responses: { 200: json(z.array(Any)) },
    }),
    async (c) =>
      c.json(await queryItems(c.env.ctx, sessionAccess(c).access, c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['items'],
      request: body(ItemCreateSchema),
      responses: { 201: json(Any) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      const { id, ...fields } = c.req.valid('json');
      const r = await writeItem(c.env.ctx, access, actor, { kind: 'upsert', id, fields });
      return c.json(await getItem(c.env.ctx, access, r.id), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['items'],
      request: { params: Id },
      responses: { 200: json(z.object({ item: Any, log: z.array(Any) })) },
    }),
    async (c) => {
      const { access } = sessionAccess(c);
      const { id } = c.req.valid('param');
      const item = await getItem(c.env.ctx, access, id);
      return c.json({ item, log: await itemLog(c.env.ctx, access, id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['items'],
      request: { params: Id, ...body(ItemPatchSchema) },
      responses: { 200: json(Any) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      const { id } = c.req.valid('param');
      // An item must exist to be patched (creating goes through POST).
      await getItem(c.env.ctx, access, id);
      await writeItem(c.env.ctx, access, actor, {
        kind: 'upsert',
        id,
        fields: c.req.valid('json'),
      });
      return c.json(await getItem(c.env.ctx, access, id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['items'],
      request: { params: Id },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      const { id } = c.req.valid('param');
      await getItem(c.env.ctx, access, id);
      await writeItem(c.env.ctx, access, actor, { kind: 'delete', id });
      return c.json({ ok: true as const }, 200);
    },
  );

  // History (§8.2): who changed the idea, and "via <client>" for MCP writes.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}/history',
      tags: ['items'],
      request: { params: Id },
      responses: { 200: json(z.array(Any)) },
    }),
    async (c) => {
      const { access } = sessionAccess(c);
      const { id } = c.req.valid('param');
      await getItem(c.env.ctx, access, id);
      const rows = await c.env.ctx.db.all<{
        at: string;
        op: string;
        actor_kind: string;
        user_name: string | null;
        client_name: string | null;
      }>(
        `SELECT ch.at, ch.op, ch.actor_kind, u.display_name AS user_name, oc.client_name
           FROM changes ch
           LEFT JOIN users u ON u.id = ch.actor_user
           LEFT JOIN oauth_clients oc ON ch.actor_kind = 'oauth' AND oc.client_id = ch.actor
          WHERE ch.entity = 'item' AND ch.entity_id = ? AND (ch.visible_to IS NULL OR ch.visible_to = ?)
          ORDER BY ch.seq DESC LIMIT 50`,
        id,
        access.userId,
      );
      return c.json(
        rows.map((r) => ({
          at: r.at,
          op: r.op,
          by: r.user_name,
          via: r.actor_kind === 'oauth' ? (r.client_name ?? 'an app') : null,
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/log',
      tags: ['items'],
      request: { params: Id, ...body(LogInputSchema) },
      responses: { 201: json(Any) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      return c.json(
        await logDone(c.env.ctx, access, actor, c.req.valid('param').id, c.req.valid('json')),
        201,
      );
    },
  );
}

function logRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['log'],
      request: { params: Id, ...body(LogPatchSchema) },
      responses: { 200: json(Any) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      return c.json(
        await updateLog(c.env.ctx, access, actor, c.req.valid('param').id, c.req.valid('json')),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['log'],
      request: { params: Id },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      await deleteLog(c.env.ctx, access, actor, c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );
}

export const itemsModule: Module = { name: 'items', routes: itemRoutes };
export const logModule: Module = { name: 'log', routes: logRoutes };
export const tagsModule: Module = {
  name: 'tags',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['items'],
        responses: { 200: json(z.array(z.object({ tag: z.string(), count: z.number() }))) },
      }),
      async (c) => c.json(await tagVocabulary(c.env.ctx, sessionAccess(c).access), 200),
    );
  },
};
