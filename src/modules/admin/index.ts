// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Instance administration (§2.3): list and disable users, change the
 * registration mode at runtime, basic stats. Admins never see other users'
 * private items: nothing here touches item content.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { conflict, notFound } from '../../core/errors';
import { iso } from '../../core/ports';
import { requireAdmin } from '../auth/middleware';
import { body, json } from '../http';
import { registrationMode } from '../instance';
import type { Module, Router } from '../types';

const UserSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  role: z.enum(['admin', 'user']),
  created_at: z.string(),
  disabled_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
});
const Ok = z.object({ ok: z.literal(true) });

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/users',
      tags: ['admin'],
      responses: { 200: json(z.array(UserSchema)) },
    }),
    async (c) => {
      requireAdmin(c);
      return c.json(
        await c.env.ctx.db.all<z.infer<typeof UserSchema>>(
          `SELECT u.id, u.display_name, u.role, u.created_at, u.disabled_at, u.deleted_at,
                  (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
             FROM users u ORDER BY u.created_at`,
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/disable',
      tags: ['admin'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const me = requireAdmin(c);
      const { id } = c.req.valid('param');
      if (id === me.userId) throw conflict('cannot_disable_self', 'You cannot disable yourself');
      const ctx = c.env.ctx;
      const [r] = await ctx.db.batch([
        {
          sql: 'UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL',
          params: [iso(ctx.clock.now()), id],
        },
        // Disabling logs the user out everywhere and revokes MCP access.
        { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] },
      ]);
      if (r?.changes === 0 && !(await ctx.db.first('SELECT 1 FROM users WHERE id = ?', id))) {
        throw notFound();
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/enable',
      tags: ['admin'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      requireAdmin(c);
      const r = await c.env.ctx.db.run(
        'UPDATE users SET disabled_at = NULL WHERE id = ?',
        c.req.valid('param').id,
      );
      if (r.changes === 0) throw notFound();
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/settings',
      tags: ['admin'],
      responses: {
        200: json(
          z.object({
            registration_mode: z.enum(['invite', 'open', 'closed']),
            registration_mode_default: z.enum(['invite', 'open', 'closed']),
          }),
        ),
      },
    }),
    async (c) => {
      requireAdmin(c);
      return c.json(
        {
          registration_mode: await registrationMode(c.env.ctx),
          registration_mode_default: c.env.ctx.config.REGISTRATION_MODE,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/settings',
      tags: ['admin'],
      request: body(
        z.object({ registration_mode: z.enum(['invite', 'open', 'closed']).nullable() }),
      ),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      requireAdmin(c);
      const mode = c.req.valid('json').registration_mode;
      if (mode === null) {
        await c.env.ctx.db.run("DELETE FROM instance_settings WHERE key = 'registration_mode'");
      } else {
        await c.env.ctx.db.run(
          `INSERT INTO instance_settings (key, value) VALUES ('registration_mode', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          JSON.stringify(mode),
        );
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/stats',
      tags: ['admin'],
      responses: { 200: json(z.record(z.string(), z.number())) },
    }),
    async (c) => {
      requireAdmin(c);
      const { db } = c.env.ctx;
      const count = async (sql: string) => (await db.first<{ n: number }>(sql))?.n ?? 0;
      return c.json(
        {
          users: await count('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL'),
          disabled_users: await count(
            'SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NOT NULL',
          ),
          lists: await count('SELECT COUNT(*) AS n FROM lists WHERE deleted_at IS NULL'),
          push_subscriptions: await count('SELECT COUNT(*) AS n FROM push_subscriptions'),
        },
        200,
      );
    },
  );
}

export const adminModule: Module = { name: 'admin', routes };
