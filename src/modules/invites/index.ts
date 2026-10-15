// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Instance invites (§2.2): single-use signup links, created by any user
 * (or admins only with INVITES_ADMIN_ONLY), expiring after INVITE_TTL_DAYS.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { randomToken, tokenHash } from '../../core/crypto';
import { HttpError, notFound } from '../../core/errors';
import { iso } from '../../core/ports';
import { ulid } from '../../core/ulid';
import { sessionOf } from '../auth/middleware';
import { json } from '../http';
import { registrationMode } from '../instance';
import type { Module, Router } from '../types';

const InviteSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  used_at: z.string().nullable(),
  used_by_name: z.string().nullable(),
});

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['invites'],
      responses: {
        200: json(z.object({ id: z.string(), url: z.string(), expires_at: z.string() })),
      },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const s = sessionOf(c);
      if (ctx.config.INVITES_ADMIN_ONLY && s.role !== 'admin') {
        throw new HttpError(403, 'forbidden', 'Only admins can create invites');
      }
      if ((await registrationMode(ctx)) === 'closed') {
        throw new HttpError(403, 'registration_closed', 'Registration is closed');
      }
      const token = randomToken(32);
      const now = ctx.clock.now();
      const id = ulid(now);
      const expiresAt = iso(now + ctx.config.INVITE_TTL_DAYS * 86_400_000);
      await ctx.db.run(
        'INSERT INTO invites (id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        id,
        await tokenHash(ctx.config.TOKEN_PEPPER, token),
        s.userId,
        iso(now),
        expiresAt,
      );
      return c.json(
        { id, url: `${ctx.config.PUBLIC_ORIGIN}/signup?invite=${token}`, expires_at: expiresAt },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['invites'],
      responses: { 200: json(z.array(InviteSchema)) },
    }),
    async (c) =>
      c.json(
        await c.env.ctx.db.all<z.infer<typeof InviteSchema>>(
          `SELECT i.id, i.created_at, i.expires_at, i.used_at, u.display_name AS used_by_name
             FROM invites i LEFT JOIN users u ON u.id = i.used_by
            WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT 50`,
          sessionOf(c).userId,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['invites'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(z.object({ ok: z.literal(true) })) },
    }),
    async (c) => {
      const r = await c.env.ctx.db.run(
        'DELETE FROM invites WHERE id = ? AND created_by = ? AND used_at IS NULL',
        c.req.valid('param').id,
        sessionOf(c).userId,
      );
      if (r.changes === 0) throw notFound();
      return c.json({ ok: true as const }, 200);
    },
  );

  // Public: lets the signup page say "this invite has expired" before the passkey prompt.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/check',
      tags: ['invites'],
      request: { query: z.object({ token: z.string().max(200) }) },
      responses: { 200: json(z.object({ valid: z.boolean() })) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const row = await ctx.db.first(
        'SELECT 1 FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
        await tokenHash(ctx.config.TOKEN_PEPPER, c.req.valid('query').token),
        iso(ctx.clock.now()),
      );
      return c.json({ valid: !!row }, 200);
    },
  );
}

export const invitesModule: Module = { name: 'invites', routes, publicPaths: ['/check'] };
