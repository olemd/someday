// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GET /api/health: version and configuration problems (public).
 * GET /healthz: plain liveness for the container HEALTHCHECK (§10a).
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Module } from '../types';

const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  git_sha: z.string(),
  config_errors: z.array(z.string()),
});

export const healthModule: Module = {
  name: 'health',
  publicPaths: ['/'],
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['health'],
        responses: { 200: json() },
      }),
      async (c) => {
        const { config, configErrors, db } = c.env.ctx;
        const errors = [...configErrors];
        try {
          await db.first('SELECT 1 FROM users LIMIT 1');
        } catch {
          errors.push('database: not reachable or migrations not applied');
        }
        return c.json(
          {
            status: errors.length ? ('degraded' as const) : ('ok' as const),
            version: config.APP_VERSION,
            git_sha: config.GIT_SHA,
            config_errors: errors,
          },
          200,
        );
      },
    );
  },
};

function json() {
  return { description: 'Health', content: { 'application/json': { schema: HealthSchema } } };
}

export const healthzModule: Module = {
  name: 'healthz',
  mountPath: '/healthz',
  routes(app) {
    app.get('/', async (c) => {
      try {
        await c.env.ctx.db.first('SELECT 1');
        return c.text('ok');
      } catch {
        return c.text('database unavailable', 503);
      }
    });
  },
};
