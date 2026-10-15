// SPDX-License-Identifier: AGPL-3.0-or-later
/** /api/lists: the viewer's lists, create, rename, membership preferences, delete/restore. */
import { createRoute, z } from '@hono/zod-openapi';
import { VISIBILITIES } from '../../shared/schemas/items';
import { sessionAccess } from '../access';
import { body, json } from '../http';
import type { Module, Router } from '../types';
import {
  createList,
  deletedLists,
  deleteList,
  getList,
  getLists,
  purgeDeletedLists,
  restoreList,
  updateList,
  updateMembership,
} from './service';

const ListSchema = z.record(z.string(), z.unknown());
const Id = z.object({ id: z.string() });
const Ok = z.object({ ok: z.literal(true) });

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['lists'],
      responses: { 200: json(z.array(ListSchema)) },
    }),
    async (c) => c.json(await getLists(c.env.ctx, sessionAccess(c).access), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['lists'],
      request: body(
        z.object({ id: z.string().regex(/^[0-9A-Za-z_-]{10,40}$/).optional(), name: z.string().trim().min(1).max(100) }),
      ),
      responses: { 201: json(ListSchema) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      return c.json(await createList(c.env.ctx, access, actor, c.req.valid('json')), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/deleted',
      tags: ['lists'],
      responses: { 200: json(z.array(ListSchema)) },
    }),
    async (c) => c.json(await deletedLists(c.env.ctx, sessionAccess(c).access.userId), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['lists'],
      request: { params: Id },
      responses: { 200: json(ListSchema) },
    }),
    async (c) =>
      c.json(await getList(c.env.ctx, sessionAccess(c).access, c.req.valid('param').id), 200),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['lists'],
      request: {
        params: Id,
        ...body(
          z.object({
            name: z.string().trim().min(1).max(100).optional(),
            // Owner override of ANON_COUNT_MIN_MEMBERS; never below 3 (§3.3).
            anon_count_min_members: z.number().int().min(3).max(1000).nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(ListSchema) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      return c.json(
        await updateList(c.env.ctx, access, actor, c.req.valid('param').id, c.req.valid('json')),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}/membership',
      tags: ['lists'],
      request: {
        params: Id,
        ...body(
          z.object({
            include_in_suggestions: z.boolean().optional(),
            log_visibility: z.enum(VISIBILITIES).optional(),
          }),
        ),
      },
      responses: { 200: json(ListSchema) },
    }),
    async (c) =>
      c.json(
        await updateMembership(
          c.env.ctx,
          sessionAccess(c).access,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['lists'],
      request: { params: Id },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      await deleteList(c.env.ctx, access, actor, c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/restore',
      tags: ['lists'],
      request: { params: Id },
      responses: { 200: json(ListSchema) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      return c.json(await restoreList(c.env.ctx, access, actor, c.req.valid('param').id), 200);
    },
  );
}

export const listsModule: Module = {
  name: 'lists',
  routes,
  async cron(ctx) {
    const n = await purgeDeletedLists(ctx);
    if (n) ctx.log.info('purged deleted lists', { count: n });
  },
};
