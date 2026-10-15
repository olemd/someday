// SPDX-License-Identifier: AGPL-3.0-or-later
/** /api/lists: the viewer's lists, create, rename, membership preferences, delete/restore. */
import { createRoute, z } from '@hono/zod-openapi';
import { HttpError } from '../../core/errors';
import { VISIBILITIES } from '../../shared/schemas/items';
import { sessionAccess } from '../access';
import { body, json } from '../http';
import { authLimit } from '../ratelimit';
import type { Module, Router } from '../types';
import {
  createListInvite,
  findJoinInvite,
  joinList,
  listInvites,
  removeMember,
  revokeListInvite,
  setMemberRole,
  transferOwnership,
} from './members';
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
const Any = ListSchema;
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
        z.object({
          id: z
            .string()
            .regex(/^[0-9A-Za-z_-]{10,40}$/)
            .optional(),
          name: z.string().trim().min(1).max(100),
        }),
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

function memberRoutes(app: Router) {
  const InviteBody = z.object({
    role: z.enum(['editor', 'viewer']).default('editor'),
    max_uses: z.number().int().min(1).max(100).default(1),
    expires_days: z.number().int().min(1).max(365).optional(),
  });

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/invites',
      tags: ['lists'],
      request: { params: Id, ...body(InviteBody) },
      responses: { 201: json(Any) },
    }),
    async (c) =>
      c.json(
        await createListInvite(
          c.env.ctx,
          sessionAccess(c).access,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}/invites',
      tags: ['lists'],
      request: { params: Id },
      responses: { 200: json(z.array(Any)) },
    }),
    async (c) =>
      c.json(await listInvites(c.env.ctx, sessionAccess(c).access, c.req.valid('param').id), 200),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}/invites/{inviteId}',
      tags: ['lists'],
      request: { params: z.object({ id: z.string(), inviteId: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { id, inviteId } = c.req.valid('param');
      await revokeListInvite(c.env.ctx, sessionAccess(c).access, id, inviteId);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}/members/{userId}',
      tags: ['lists'],
      request: {
        params: z.object({ id: z.string(), userId: z.string() }),
        ...body(z.object({ role: z.enum(['editor', 'viewer']) })),
      },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      const { id, userId } = c.req.valid('param');
      await setMemberRole(c.env.ctx, access, actor, id, userId, c.req.valid('json').role);
      return c.json({ ok: true as const }, 200);
    },
  );

  // Owner removes someone, or a member leaves (their own user ID).
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}/members/{userId}',
      tags: ['lists'],
      request: { params: z.object({ id: z.string(), userId: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      const { id, userId } = c.req.valid('param');
      await removeMember(c.env.ctx, access, actor, id, userId);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/transfer',
      tags: ['lists'],
      request: { params: Id, ...body(z.object({ user_id: z.string() })) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { access, actor } = sessionAccess(c);
      await transferOwnership(
        c.env.ctx,
        access,
        actor,
        c.req.valid('param').id,
        c.req.valid('json').user_id,
      );
      return c.json({ ok: true as const }, 200);
    },
  );
}

/** /api/join/{token}: preview (public, for the signup page) and accept a list invite. */
function joinRoutes(app: Router) {
  const Token = z.object({ token: z.string().min(10).max(200) });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/{token}',
      tags: ['lists'],
      request: { params: Token },
      responses: {
        200: json(
          z.object({
            list_name: z.string(),
            inviter: z.string().nullable(),
            role: z.enum(['editor', 'viewer']),
          }),
        ),
      },
    }),
    async (c) => {
      await authLimit(c, 'join');
      const invite = await findJoinInvite(c.env.ctx, c.req.valid('param').token);
      if (!invite) throw new HttpError(410, 'invite_invalid', 'This invite is invalid or used up');
      return c.json(
        { list_name: invite.list_name, inviter: invite.inviter, role: invite.role },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{token}',
      tags: ['lists'],
      request: { params: Token },
      responses: { 200: json(z.object({ list_id: z.string(), already_member: z.boolean() })) },
    }),
    async (c) => {
      await authLimit(c, 'join');
      const { access } = sessionAccess(c);
      return c.json(await joinList(c.env.ctx, access.userId, c.req.valid('param').token), 200);
    },
  );
}

/** GET is public (the invite page shows before login); POST needs a session (checked in the handler). */
export const joinModule: Module = { name: 'join', routes: joinRoutes, publicPaths: ['/*'] };

export const listsModule: Module = {
  name: 'lists',
  routes(app) {
    memberRoutes(app);
    routes(app);
  },
  async cron(ctx) {
    const n = await purgeDeletedLists(ctx);
    if (n) ctx.log.info('purged deleted lists', { count: n });
  },
};
