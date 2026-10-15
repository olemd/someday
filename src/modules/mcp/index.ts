// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * POST /mcp — Model Context Protocol over Streamable HTTP (§8), protocol
 * revision 2026-07-28 (stateless: no initialize handshake, no sessions; every
 * request carries its version and client capabilities in `_meta`, mirrored in
 * the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers).
 *
 * Dual-era, as the spec allows: an `initialize` request selects legacy
 * semantics (2025-11-25 and earlier) so current clients work too. Even then
 * the server mints no session: every request stands on its own.
 *
 * Auth: OAuth 2.1 bearer tokens issued by this app for this endpoint only
 * (§8.1). 401 carries the protected-resource metadata URL; a tool whose scope
 * the token lacks gets 403 insufficient_scope.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../core/errors';
import type { Actor } from '../data/changes';
import type { Access } from '../lists/access';
import { cors } from '../oauth';
import { verifyAccessToken } from '../oauth/tokens';
import type { AppEnv, AuthInfo, Module, Router } from '../types';
import { TOOLS, toolList } from './tools';

export const PROTOCOL_VERSION = '2026-07-28';
/** Legacy (initialize-based) revisions served for older clients. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED = [PROTOCOL_VERSION, ...LEGACY_VERSIONS];

const META = 'io.modelcontextprotocol';
const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

type Id = string | number;
interface RpcRequest {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

const rpcError = (id: Id | null, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  ...(id !== null ? { id } : {}),
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

function serverInfo(c: Context<AppEnv>) {
  return {
    name: 'someday',
    title: c.env.ctx.config.RP_NAME,
    version: c.env.ctx.config.APP_VERSION,
  };
}

const INSTRUCTIONS =
  'Someday is a slow-moving list of things the user wants to do or find out about some day. ' +
  'Use suggest for "give me something to do"; search_items and get_item to look things up; ' +
  'create_item to add ideas; log_done when the user did something (private by default).';

function challenge(c: Context<AppEnv>, extra = '') {
  const o = c.env.ctx.config.PUBLIC_ORIGIN;
  return `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource", scope="someday:read someday:write someday:notify"${extra}`;
}

/** Decode the `=?base64?…?=` sentinel used for non-ASCII header values. */
export function decodeHeaderValue(v: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  const bin = atob(m[1]!);
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/**
 * Browsers send Origin; DNS-rebinding protection (§ Streamable HTTP) rejects
 * origins that are neither https nor local. Bearer tokens are not ambient,
 * so any https origin (a web-based MCP host) is acceptable.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

async function callTool(
  c: Context<AppEnv>,
  auth: Extract<AuthInfo, { kind: 'oauth' }>,
  id: Id,
  params: Record<string, unknown>,
  modern: boolean,
): Promise<Response> {
  const name = params.name;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return c.json(rpcError(id, ERR.invalidParams, `Unknown tool: ${String(name)}`), 200);
  // Scope hierarchy: write implies read.
  const has = (s: string) =>
    auth.scopes.includes(s as never) ||
    (s === 'someday:read' && auth.scopes.includes('someday:write'));
  if (!has(tool.scope)) {
    c.header(
      'www-authenticate',
      challenge(
        c,
        `, error="insufficient_scope", error_description="${tool.name} needs ${tool.scope}"`,
      ).replace(/scope="[^"]*"/, `scope="${tool.scope}"`),
    );
    return c.json(
      rpcError(id, ERR.invalidRequest, `This connection lacks the ${tool.scope} scope`),
      403,
    );
  }
  const parsed = (tool.input as z.ZodType).safeParse(params.arguments ?? {});
  const access: Access = { userId: auth.userId, listIds: auth.listIds };
  const actor: Actor = { id: auth.clientId, kind: 'oauth', userId: auth.userId };
  let result: Record<string, unknown>;
  if (!parsed.success) {
    // Tool input errors are results the model can see and correct (not protocol errors).
    result = {
      content: [{ type: 'text', text: `Invalid arguments: ${z.prettifyError(parsed.error)}` }],
      isError: true,
    };
  } else {
    try {
      const out = await (
        tool.run as (t: unknown, a: unknown) => Promise<{ text: string; data: unknown }>
      )({ ctx: c.env.ctx, access, actor }, parsed.data);
      result = { content: [{ type: 'text', text: out.text }], structuredContent: out.data };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      result = { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
  return c.json(
    {
      jsonrpc: '2.0',
      id,
      result: {
        ...(modern
          ? { resultType: 'complete', _meta: { [`${META}/serverInfo`]: serverInfo(c) } }
          : {}),
        ...result,
      },
    },
    200,
  );
}

/** subscriptions/listen: nothing here changes at runtime, so acknowledge none and close gracefully. */
function listen(id: Id) {
  const meta = { [`${META}/subscriptionId`]: id };
  const events = [
    {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: meta, notifications: {} },
    },
    { jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: meta } },
  ];
  return new Response(
    events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    },
  );
}

async function handle(c: Context<AppEnv>): Promise<Response> {
  const ctx = c.env.ctx;
  if (!originAllowed(c.req.header('origin'))) {
    return c.json(rpcError(null, ERR.invalidRequest, 'Origin not allowed'), 403);
  }

  // ── Authentication ──────────────────────────────────────────────────
  const authz = c.req.header('authorization') ?? '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  const auth = token ? await verifyAccessToken(ctx, token) : null;
  if (!auth) {
    c.header('www-authenticate', challenge(c, token ? ', error="invalid_token"' : ''));
    return c.json(rpcError(null, ERR.invalidRequest, 'Authorization required'), 401);
  }
  if (!(await ctx.rateLimit(`mcp:${auth.tokenId}`, ctx.config.MCP_RATE_LIMIT_PER_MIN, 60))) {
    c.header('retry-after', '60');
    return c.json(rpcError(null, ERR.invalidRequest, 'Too many requests'), 429);
  }

  // ── JSON-RPC ────────────────────────────────────────────────────────
  let msg: RpcRequest;
  try {
    msg = (await c.req.json()) as RpcRequest;
  } catch {
    return c.json(rpcError(null, ERR.parse, 'Parse error'), 400);
  }
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return c.json(rpcError(null, ERR.invalidRequest, 'Invalid request'), 400);
  }
  // Notifications (e.g. legacy notifications/initialized) are accepted and ignored.
  if (msg.id === undefined || msg.id === null) return c.body(null, 202);
  const id = msg.id;
  const params = msg.params ?? {};
  const meta = params._meta ?? {};
  const requested = meta[`${META}/protocolVersion`];

  // ── Legacy era: initialize handshake (stateless here) ───────────────
  if (msg.method === 'initialize' || requested === undefined) {
    if (msg.method === 'initialize') {
      const asked = String(params.protocolVersion ?? '');
      return c.json(
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: serverInfo(c),
            instructions: INSTRUCTIONS,
          },
        },
        200,
      );
    }
    const header = c.req.header('mcp-protocol-version') ?? '2025-03-26';
    if (!LEGACY_VERSIONS.includes(header)) {
      return c.json(
        rpcError(id, ERR.unsupportedVersion, 'Unsupported protocol version', {
          supported: SUPPORTED,
          requested: header,
        }),
        400,
      );
    }
    switch (msg.method) {
      case 'ping':
        return c.json({ jsonrpc: '2.0', id, result: {} }, 200);
      case 'tools/list':
        return c.json({ jsonrpc: '2.0', id, result: { tools: toolList() } }, 200);
      case 'tools/call':
        return callTool(c, auth, id, params, false);
      default:
        return c.json(rpcError(id, ERR.methodNotFound, `Method not found: ${msg.method}`), 200);
    }
  }

  // ── Modern era (2026-07-28) ─────────────────────────────────────────
  const headerVersion = c.req.header('mcp-protocol-version');
  if (headerVersion !== requested) {
    return c.json(
      rpcError(
        id,
        ERR.headerMismatch,
        `Header mismatch: MCP-Protocol-Version '${headerVersion ?? ''}' does not match body '${String(requested)}'`,
      ),
      400,
    );
  }
  if (requested !== PROTOCOL_VERSION) {
    return c.json(
      rpcError(id, ERR.unsupportedVersion, 'Unsupported protocol version', {
        supported: SUPPORTED,
        requested,
      }),
      400,
    );
  }
  if (
    !meta[`${META}/clientCapabilities`] ||
    typeof meta[`${META}/clientCapabilities`] !== 'object'
  ) {
    return c.json(
      rpcError(id, ERR.invalidParams, 'Missing io.modelcontextprotocol/clientCapabilities'),
      400,
    );
  }
  if (c.req.header('mcp-method') !== msg.method) {
    return c.json(
      rpcError(id, ERR.headerMismatch, 'Header mismatch: Mcp-Method does not match body method'),
      400,
    );
  }
  if (
    msg.method === 'tools/call' ||
    msg.method === 'resources/read' ||
    msg.method === 'prompts/get'
  ) {
    const nameHeader = c.req.header('mcp-name');
    const bodyName = String(params.name ?? params.uri ?? '');
    if (nameHeader === undefined || decodeHeaderValue(nameHeader) !== bodyName) {
      return c.json(
        rpcError(id, ERR.headerMismatch, 'Header mismatch: Mcp-Name does not match body'),
        400,
      );
    }
  }

  const done = (result: Record<string, unknown>) =>
    c.json(
      {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          ...result,
          _meta: { [`${META}/serverInfo`]: serverInfo(c) },
        },
      },
      200,
    );

  switch (msg.method) {
    case 'server/discover':
      return done({
        supportedVersions: SUPPORTED,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
      });
    case 'tools/list':
      return done({ tools: toolList(), ttlMs: 3_600_000, cacheScope: 'public' });
    case 'tools/call':
      return callTool(c, auth, id, params, true);
    case 'subscriptions/listen':
      return listen(id);
    default:
      return c.json(rpcError(id, ERR.methodNotFound, `Method not found: ${msg.method}`), 404);
  }
}

function routes(app: Router) {
  app.use('*', cors);
  app.post('/', handle);
  // No GET stream and no sessions in this revision.
  app.on(['GET', 'DELETE'], '/', (c) => {
    c.header('allow', 'POST');
    return c.json(rpcError(null, ERR.invalidRequest, 'Method not allowed'), 405);
  });
}

export const mcpModule: Module = { name: 'mcp', mountPath: '/mcp', routes };
