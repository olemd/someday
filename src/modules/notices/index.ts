// SPDX-License-Identifier: AGPL-3.0-or-later
/** In-app notices (§2.1): list and dismiss. */
import { createRoute, z } from '@hono/zod-openapi';
import { iso } from '../../core/ports';
import { sessionOf } from '../auth/middleware';
import { json } from '../http';
import type { Module, Router } from '../types';

const NoticeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['notices'],
      responses: { 200: json(z.array(NoticeSchema)) },
    }),
    async (c) => {
      const rows = await c.env.ctx.db.all<{
        id: string;
        kind: string;
        data: string;
        created_at: string;
      }>(
        `SELECT id, kind, data, created_at FROM notices
          WHERE user_id = ? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 20`,
        sessionOf(c).userId,
      );
      return c.json(
        rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/dismiss',
      tags: ['notices'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(z.object({ ok: z.literal(true) })) },
    }),
    async (c) => {
      await c.env.ctx.db.run(
        'UPDATE notices SET dismissed_at = ? WHERE id = ? AND user_id = ?',
        iso(c.env.ctx.clock.now()),
        c.req.valid('param').id,
        sessionOf(c).userId,
      );
      return c.json({ ok: true as const }, 200);
    },
  );
}

export const noticesModule: Module = { name: 'notices', routes };
