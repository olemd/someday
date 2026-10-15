// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builds the Hono app from the module list (§1.1: constructed once, mounted
 * by both entry points). Platform-agnostic: the platform layer passes a fully
 * built `Ctx` as the `ctx` binding on every request.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { HttpError } from '../core/errors';
import { authenticate } from './auth/middleware';
import type { AppEnv, Module, Router } from './types';

/** Uniform 400 for zod validation failures on every route. */
export function newRouter(): Router {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: 'validation',
            message: 'Invalid request',
            issues: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        );
      }
    },
  });
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * §9 CSRF: state-changing /api requests (cookie-authenticated) must carry an
 * Origin equal to PUBLIC_ORIGIN, on top of SameSite=Lax.
 */
const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (STATE_CHANGING.has(c.req.method)) {
    if (c.req.header('origin') !== c.env.ctx.config.PUBLIC_ORIGIN) {
      return c.json({ error: 'bad_origin', message: 'Cross-origin request rejected' }, 403);
    }
  }
  await next();
};

/** Paths the server (Worker or Bun) answers itself; everything else is the PWA. */
export function isServerPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/') ||
    pathname === '/mcp' ||
    pathname === '/healthz' ||
    pathname.startsWith('/.well-known/oauth-') ||
    pathname === '/oauth/token' ||
    pathname === '/oauth/register' ||
    pathname === '/oauth/revoke'
  );
}

export function createApp(modules: Module[]): Router {
  const app = newRouter();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      strictTransportSecurity: 'max-age=63072000; includeSubDomains',
      referrerPolicy: 'same-origin',
      xContentTypeOptions: 'nosniff',
      xFrameOptions: 'DENY',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
      crossOriginEmbedderPolicy: false,
      // OAuth clients and MCP hosts call /mcp and /oauth/* from other origins.
      crossOriginResourcePolicy: false,
    }),
  );
  app.use('*', async (c, next) => {
    // Responses are per-user and must never be cached by intermediaries.
    await next();
    if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  });
  app.use('/api/*', originCheck);

  const publicPaths = new Set<string>(['/api/openapi.json']);
  for (const m of modules) {
    const base = m.mountPath ?? `/api/${m.name}`;
    for (const p of m.publicPaths ?? []) publicPaths.add(base + (p === '/' ? '' : p));
  }
  app.use('/api/*', authenticate(publicPaths));

  for (const m of modules) {
    if (!m.routes) continue;
    const r = newRouter();
    m.routes(r);
    app.route(m.mountPath ?? `/api/${m.name}`, r);
  }

  // OpenAPI 3.1 document generated from the zod route schemas, built once per isolate.
  let doc: unknown = null;
  app.get('/api/openapi.json', (c) => {
    doc ??= app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: {
        title: 'Someday API',
        version: c.env.ctx.config.APP_VERSION,
        license: { name: 'AGPL-3.0-or-later', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
      },
      servers: [{ url: c.env.ctx.config.PUBLIC_ORIGIN }],
    });
    return c.json(doc);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'Not found' }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message, ...err.details }, err.status);
    }
    c.env.ctx.log.error('unhandled error', { err: String(err), stack: (err as Error).stack });
    return c.json({ error: 'internal', message: 'Internal error' }, 500);
  });

  return app;
}
