// SPDX-License-Identifier: AGPL-3.0-or-later
/** Takeaway (§7): /api/export, /api/import, /api/account (deletion). */
import { createRoute, z } from '@hono/zod-openapi';
import { HttpError } from '../../core/errors';
import { sessionAccess } from '../access';
import { requireFreshAuth } from '../auth/middleware';
import { clearSessionCookie } from '../auth/session';
import { body, json } from '../http';
import type { Module, Router } from '../types';
import { deleteAccount, ownedSharedLists, purgeDeletedAccounts } from './account';
import { buildExport, buildExportZip } from './export';
import { importData, parseUpload } from './import';

/** Uploads larger than this are refused before parsing. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function exportRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['takeaway'],
      responses: {
        200: { description: 'Zip archive', content: { 'application/zip': { schema: z.any() } } },
      },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const zip = await buildExportZip(ctx, sessionAccess(c).access);
      const date = new Date(ctx.clock.now()).toISOString().slice(0, 10);
      return new Response(zip, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="someday-export-${date}.zip"`,
          'cache-control': 'no-store',
        },
      }) as never;
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/json',
      tags: ['takeaway'],
      responses: { 200: json(z.record(z.string(), z.unknown())) },
    }),
    async (c) => c.json(await buildExport(c.env.ctx, sessionAccess(c).access), 200),
  );
}

function importRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['takeaway'],
      request: {
        query: z.object({
          mode: z.enum(['new', 'merge']).default('new'),
          list_id: z.string().optional(),
          dry_run: z
            .enum(['true', 'false'])
            .default('true')
            .transform((v) => v === 'true'),
        }),
      },
      responses: { 200: json(z.record(z.string(), z.unknown())) },
    }),
    async (c) => {
      const len = Number(c.req.header('content-length') ?? 0);
      if (len > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'The file is too large');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length > MAX_UPLOAD_BYTES)
        throw new HttpError(413, 'too_large', 'The file is too large');
      const data = parseUpload(bytes);
      const { access, actor } = sessionAccess(c);
      return c.json(await importData(c.env.ctx, access, actor, data, c.req.valid('query')), 200);
    },
  );
}

const Decision = z.union([z.literal('delete'), z.object({ transfer_to: z.string() })]);

function accountRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/deletion',
      tags: ['takeaway'],
      responses: {
        200: json(
          z.object({
            shared_lists: z.array(z.record(z.string(), z.unknown())),
            grace_days: z.number(),
          }),
        ),
      },
    }),
    async (c) =>
      c.json(
        {
          shared_lists: await ownedSharedLists(c.env.ctx, sessionAccess(c).access.userId),
          grace_days: c.env.ctx.config.DELETE_GRACE_DAYS,
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/delete',
      tags: ['takeaway'],
      request: body(z.object({ lists: z.record(z.string(), Decision).default({}) })),
      responses: { 200: json(z.object({ ok: z.literal(true) })) },
    }),
    async (c) => {
      const s = requireFreshAuth(c);
      await deleteAccount(c.env.ctx, s.userId, c.req.valid('json').lists);
      clearSessionCookie(c);
      c.env.ctx.log.info('account deletion requested', { user: s.userId });
      return c.json({ ok: true as const }, 200);
    },
  );
}

export const exportModule: Module = { name: 'export', routes: exportRoutes };
export const importModule: Module = { name: 'import', routes: importRoutes };
export const accountModule: Module = {
  name: 'account',
  routes: accountRoutes,
  async cron(ctx) {
    const n = await purgeDeletedAccounts(ctx);
    if (n) ctx.log.info('purged deleted accounts', { count: n });
  },
};
