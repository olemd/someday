// SPDX-License-Identifier: AGPL-3.0-or-later
/** Web Push subscriptions (§5): one per device, managed in settings. */
import { createRoute, z } from '@hono/zod-openapi';
import { badRequest, HttpError } from '../../core/errors';
import { iso } from '../../core/ports';
import { sessionOf } from '../auth/middleware';
import { body, json } from '../http';
import { translatorFor } from '../notices/service';
import type { Module, Router } from '../types';
import { sendToUser } from './service';

const Subscribe = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://'), 'push endpoints must use https'),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(32) }),
  label: z.string().max(100).optional(),
});
const Subscription = z.object({
  endpoint: z.string(),
  label: z.string().nullable(),
  created_at: z.string(),
  last_ok_at: z.string().nullable(),
});
const Ok = z.object({ ok: z.literal(true) });

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/subscriptions',
      tags: ['push'],
      responses: { 200: json(z.array(Subscription)) },
    }),
    async (c) =>
      c.json(
        await c.env.ctx.db.all<z.infer<typeof Subscription>>(
          `SELECT endpoint, label, created_at, last_ok_at FROM push_subscriptions
            WHERE user_id = ? ORDER BY created_at`,
          sessionOf(c).userId,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/subscribe',
      tags: ['push'],
      request: body(Subscribe),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const { endpoint, keys, label } = c.req.valid('json');
      if (new URL(endpoint).origin === ctx.config.PUBLIC_ORIGIN) throw badRequest('bad_endpoint');
      // An endpoint belongs to one browser profile; re-subscribing moves it
      // to whoever is logged in there now.
      await ctx.db.run(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
           auth = excluded.auth, label = excluded.label`,
        endpoint,
        sessionOf(c).userId,
        keys.p256dh,
        keys.auth,
        label ?? null,
        iso(ctx.clock.now()),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/subscribe',
      tags: ['push'],
      request: body(z.object({ endpoint: z.string().max(2048) })),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      await c.env.ctx.db.run(
        'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
        c.req.valid('json').endpoint,
        sessionOf(c).userId,
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/test',
      tags: ['push'],
      responses: { 200: json(z.object({ sent: z.number(), removed: z.number() })) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      if (!ctx.push) throw new HttpError(503, 'push_not_configured', 'Push is not configured');
      const userId = sessionOf(c).userId;
      // Test pushes are rate limited: they go to third-party push services.
      if (!(await ctx.rateLimit(`push-test:${userId}`, 10, 3600))) {
        throw new HttpError(429, 'rate_limited', 'Too many test notifications');
      }
      const { t } = await translatorFor(ctx, userId);
      return c.json(
        await sendToUser(ctx, userId, {
          title: t('push.testTitle'),
          body: t('push.testBody'),
          url: '/settings/notifications',
          tag: 'test',
        }),
        200,
      );
    },
  );
}

export const pushModule: Module = { name: 'push', routes };
