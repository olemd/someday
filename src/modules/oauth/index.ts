// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app as its own OAuth 2.1 authorization server for MCP (§8.1):
 * - /.well-known/oauth-protected-resource (RFC 9728) and
 *   /.well-known/oauth-authorization-server (RFC 8414),
 * - /oauth/authorize is a page of the PWA (consent needs an active passkey
 *   session); it talks to /api/oauth/authorize,
 * - /oauth/token (authorization code + PKCE S256, refresh with rotation),
 *   /oauth/revoke (RFC 7009), /oauth/register (RFC 7591, only with
 *   MCP_ALLOW_DCR),
 * - /api/oauth/grants: connected clients in settings.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { randomToken } from '../../core/crypto';
import { badRequest, notFound } from '../../core/errors';
import { iso } from '../../core/ports';
import { ulid } from '../../core/ulid';
import { sessionOf } from '../auth/middleware';
import { body, json } from '../http';
import { getLists } from '../lists/service';
import { limitOrThrow } from '../ratelimit';
import type { AppEnv, Ctx, Module, Router, Scope } from '../types';
import {
  checkDcr,
  DcrSchema,
  isLoopback,
  OAuthError,
  type OAuthClient,
  redirectAllowed,
  resolveClient,
} from './clients';
import {
  createCode,
  exchangeCode,
  mcpResource,
  parseScopes,
  purgeTokens,
  refresh,
  resourceMatches,
  revokeToken,
  SCOPES,
} from './tokens';

/** Cross-origin access for OAuth clients and MCP hosts (tokens are never ambient). */
export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers':
          'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id',
        'access-control-expose-headers': 'www-authenticate, mcp-protocol-version',
        'access-control-max-age': '86400',
      },
    });
  }
  await next();
  c.res.headers.set('access-control-allow-origin', '*');
  c.res.headers.set('access-control-expose-headers', 'www-authenticate, mcp-protocol-version');
};

export function protectedResourceMetadata(ctx: Ctx) {
  return {
    resource: mcpResource(ctx),
    authorization_servers: [ctx.config.PUBLIC_ORIGIN],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: ctx.config.RP_NAME,
    resource_documentation: ctx.config.SOURCE_URL,
  };
}

export function authorizationServerMetadata(ctx: Ctx) {
  const o = ctx.config.PUBLIC_ORIGIN;
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    revocation_endpoint: `${o}/oauth/revoke`,
    ...(ctx.config.MCP_ALLOW_DCR ? { registration_endpoint: `${o}/oauth/register` } : {}),
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

function wellKnownRoutes(app: Router) {
  app.use('*', cors);
  const prm = (c: Context<AppEnv>) => {
    c.header('cache-control', 'public, max-age=3600');
    return c.json(protectedResourceMetadata(c.env.ctx));
  };
  app.get('/oauth-protected-resource', prm);
  app.get('/oauth-protected-resource/mcp', prm);
  app.get('/oauth-authorization-server', (c) => {
    c.header('cache-control', 'public, max-age=3600');
    return c.json(authorizationServerMetadata(c.env.ctx));
  });
}

// ── /oauth/* (token, revoke, register) ─────────────────────────────────

function oauthErrorResponse(err: OAuthError) {
  return new Response(JSON.stringify({ error: err.error, error_description: err.description }), {
    status: err.error === 'invalid_client' ? 401 : err.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

async function formParams(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  const b = await c.req.parseBody();
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)]));
}

function oauthRoutes(app: Router) {
  app.use('*', cors);

  app.post('/token', async (c) => {
    const ctx = c.env.ctx;
    try {
      await limitOrThrow(ctx, `token:${ctx.clientIp(c.req.raw)}`, 60, 60).catch(() => {
        throw new OAuthError('slow_down', 'Too many requests', 429);
      });
      const p = await formParams(c);
      if (!p.client_id) throw new OAuthError('invalid_request', 'client_id is required');
      if (p.resource !== undefined && !resourceMatches(ctx, p.resource)) {
        throw new OAuthError('invalid_target', 'Unknown resource');
      }
      let result: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string;
      };
      if (p.grant_type === 'authorization_code') {
        if (!p.code || !p.redirect_uri || !p.code_verifier) {
          throw new OAuthError(
            'invalid_request',
            'code, redirect_uri and code_verifier are required',
          );
        }
        result = await exchangeCode(ctx, {
          code: p.code,
          client_id: p.client_id,
          redirect_uri: p.redirect_uri,
          code_verifier: p.code_verifier,
        });
      } else if (p.grant_type === 'refresh_token') {
        if (!p.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required');
        result = await refresh(ctx, { refresh_token: p.refresh_token, client_id: p.client_id });
      } else {
        throw new OAuthError('unsupported_grant_type', 'Unsupported grant_type');
      }
      return new Response(JSON.stringify({ ...result, token_type: 'Bearer' }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          pragma: 'no-cache',
        },
      });
    } catch (err) {
      if (err instanceof OAuthError) return oauthErrorResponse(err);
      throw err;
    }
  });

  app.post('/revoke', async (c) => {
    const p = await formParams(c);
    if (p.token) await revokeToken(c.env.ctx, p.token);
    return c.body(null, 200);
  });

  app.post('/register', async (c) => {
    const ctx = c.env.ctx;
    if (!ctx.config.MCP_ALLOW_DCR) return c.json({ error: 'not_found' }, 404);
    await limitOrThrow(ctx, `register:${ctx.clientIp(c.req.raw)}`, 10, 3600);
    const parsed = DcrSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'Invalid metadata' },
        400,
      );
    }
    try {
      checkDcr(parsed.data);
    } catch (err) {
      return c.json(
        { error: 'invalid_redirect_uri', error_description: String((err as Error).message) },
        400,
      );
    }
    const clientId = `dcr_${randomToken(16)}`;
    const now = ctx.clock.now();
    const name = parsed.data.client_name ?? 'MCP client';
    await ctx.db.run(
      `INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, fetched_at, created_at)
       VALUES (?, 'dcr', ?, ?, ?, ?, ?)`,
      clientId,
      name,
      parsed.data.client_uri ?? null,
      JSON.stringify(parsed.data.redirect_uris),
      iso(now),
      iso(now),
    );
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: name,
        redirect_uris: parsed.data.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  });
}

// ── /api/oauth: consent and connected clients (session only) ────────────

const AuthorizeQuery = z.object({
  response_type: z.string().optional(),
  client_id: z.string().max(2000),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().max(500).optional(),
  state: z.string().max(1000).optional(),
  resource: z.string().max(2000).optional(),
});
type AuthorizeParams = z.infer<typeof AuthorizeQuery>;

/** An error to send back to the client's redirect URI (RFC 6749 §4.1.2.1 + RFC 9207 iss). */
function errorRedirect(ctx: Ctx, p: AuthorizeParams, error: string, description: string) {
  const u = new URL(p.redirect_uri!);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (p.state) u.searchParams.set('state', p.state);
  u.searchParams.set('iss', ctx.config.PUBLIC_ORIGIN);
  return u.toString();
}

/**
 * Validate an authorization request. Client and redirect URI problems are
 * shown to the user (never redirect to an unverified URI); everything after
 * is reported to the client through the redirect.
 */
async function validateAuthorize(
  ctx: Ctx,
  p: AuthorizeParams,
): Promise<
  | { ok: true; client: OAuthClient; scopes: Scope[] }
  | { ok: false; redirect: string }
  | { ok: false; error: string; message: string }
> {
  let client: OAuthClient;
  try {
    client = await resolveClient(ctx, p.client_id);
  } catch (err) {
    if (err instanceof OAuthError) return { ok: false, error: err.error, message: err.description };
    throw err;
  }
  if (!p.redirect_uri || !redirectAllowed(client, p.redirect_uri)) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      message: 'This redirect address is not registered for the client',
    };
  }
  if (p.response_type !== 'code') {
    return {
      ok: false,
      redirect: errorRedirect(
        ctx,
        p,
        'unsupported_response_type',
        'Only response_type=code is supported',
      ),
    };
  }
  if (!p.code_challenge || p.code_challenge_method !== 'S256') {
    return {
      ok: false,
      redirect: errorRedirect(ctx, p, 'invalid_request', 'PKCE with S256 is required'),
    };
  }
  if (!resourceMatches(ctx, p.resource)) {
    return { ok: false, redirect: errorRedirect(ctx, p, 'invalid_target', 'Unknown resource') };
  }
  // No scope requested: everything this server offers, narrowed on the consent screen.
  const scopes = p.scope ? parseScopes(p.scope) : SCOPES;
  if (!scopes.length) {
    return {
      ok: false,
      redirect: errorRedirect(ctx, p, 'invalid_scope', 'None of the requested scopes are known'),
    };
  }
  return { ok: true, client, scopes };
}

function apiRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/authorize',
      tags: ['oauth'],
      request: { query: AuthorizeQuery },
      responses: { 200: json(z.record(z.string(), z.unknown())) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const p = c.req.valid('query');
      const v = await validateAuthorize(ctx, p);
      if (!v.ok) return c.json(v, 200);
      const redirect = new URL(p.redirect_uri!);
      const lists = await getLists(ctx, { userId: sessionOf(c).userId, listIds: null });
      return c.json(
        {
          ok: true,
          client: {
            client_id: v.client.client_id,
            client_name: v.client.client_name,
            client_uri: v.client.client_uri,
            kind: v.client.kind,
          },
          redirect_host: redirect.host,
          // §8.1 security: clearly warn for localhost-only redirect URIs.
          localhost: isLoopback(redirect),
          scopes: v.scopes,
          lists: lists.map((l) => ({ id: l.id, name: l.name, role: l.role })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/authorize',
      tags: ['oauth'],
      request: body(
        AuthorizeQuery.extend({
          decision: z.enum(['allow', 'deny']),
          granted_scopes: z
            .array(z.enum(['someday:read', 'someday:write', 'someday:notify']))
            .default([]),
          list_ids: z.array(z.string()).max(500).nullable().default(null),
        }),
      ),
      responses: { 200: json(z.object({ redirect: z.string() })) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const userId = sessionOf(c).userId;
      const p = c.req.valid('json');
      const v = await validateAuthorize(ctx, p);
      if (!v.ok) {
        if ('redirect' in v) return c.json({ redirect: v.redirect }, 200);
        throw badRequest(v.error, v.message);
      }
      if (p.decision === 'deny' || !p.granted_scopes.length) {
        return c.json(
          { redirect: errorRedirect(ctx, p, 'access_denied', 'The user declined') },
          200,
        );
      }
      // The user can narrow, never widen, what the client asked for.
      const scopes = v.scopes.filter((s) => p.granted_scopes.includes(s));
      let listIds: string[] | null = null;
      if (p.list_ids) {
        const mine = new Set((await getLists(ctx, { userId, listIds: null })).map((l) => l.id));
        listIds = p.list_ids.filter((id) => mine.has(id));
        if (!listIds.length) throw badRequest('no_lists', 'Choose at least one list');
      }
      const now = iso(ctx.clock.now());
      const grantId = ulid(ctx.clock.now());
      await ctx.db.run(
        `INSERT INTO oauth_grants (id, user_id, client_id, scopes, list_ids, resource, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, client_id) DO UPDATE SET scopes = excluded.scopes,
           list_ids = excluded.list_ids, resource = excluded.resource`,
        grantId,
        userId,
        v.client.client_id,
        scopes.join(' '),
        listIds ? JSON.stringify(listIds) : null,
        mcpResource(ctx),
        now,
      );
      const grant = await ctx.db.first<{ id: string }>(
        'SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ?',
        userId,
        v.client.client_id,
      );
      const code = await createCode(ctx, grant!.id, p.redirect_uri!, p.code_challenge!);
      const u = new URL(p.redirect_uri!);
      u.searchParams.set('code', code);
      if (p.state) u.searchParams.set('state', p.state);
      u.searchParams.set('iss', ctx.config.PUBLIC_ORIGIN);
      ctx.log.info('oauth consent', { user: userId, client: v.client.client_id, scopes });
      return c.json({ redirect: u.toString() }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/grants',
      tags: ['oauth'],
      responses: { 200: json(z.array(z.record(z.string(), z.unknown()))) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const userId = sessionOf(c).userId;
      const rows = await ctx.db.all<{
        id: string;
        client_id: string;
        client_name: string;
        client_uri: string | null;
        scopes: string;
        list_ids: string | null;
        created_at: string;
        last_used_at: string | null;
      }>(
        `SELECT g.id, g.client_id, c.client_name, c.client_uri, g.scopes, g.list_ids, g.created_at, g.last_used_at
           FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
          WHERE g.user_id = ? ORDER BY g.created_at DESC`,
        userId,
      );
      const names = new Map(
        (await getLists(ctx, { userId, listIds: null })).map((l) => [l.id, l.name]),
      );
      return c.json(
        rows.map((r) => ({
          ...r,
          scopes: r.scopes.split(' '),
          lists: r.list_ids
            ? (JSON.parse(r.list_ids) as string[]).map((id) => names.get(id)).filter(Boolean)
            : null,
          list_ids: undefined,
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/grants/{id}',
      tags: ['oauth'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(z.object({ ok: z.literal(true) })) },
    }),
    async (c) => {
      // Deleting the grant cascades to its codes and tokens: revoked at once.
      const r = await c.env.ctx.db.run(
        'DELETE FROM oauth_grants WHERE id = ? AND user_id = ?',
        c.req.valid('param').id,
        sessionOf(c).userId,
      );
      if (r.changes === 0) throw notFound();
      return c.json({ ok: true as const }, 200);
    },
  );
}

export const wellKnownModule: Module = {
  name: 'well-known',
  mountPath: '/.well-known',
  routes: wellKnownRoutes,
};
export const oauthModule: Module = {
  name: 'oauth-endpoints',
  mountPath: '/oauth',
  routes: oauthRoutes,
  cron: purgeTokens,
};
export const oauthApiModule: Module = { name: 'oauth', routes: apiRoutes };
