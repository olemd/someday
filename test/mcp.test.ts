// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { toBase64Url } from '../src/core/crypto';
import { authed, call, DAY, HOUR, ORIGIN, otherUser, resetDb, type Harness } from './helpers';

beforeEach(resetDb);

type H = Harness & { user: { id: string; defaultListId: string } };

const CLIENT = 'https://client.example/oauth/metadata.json';
const REDIRECT = 'http://127.0.0.1:33418/callback';

/** A fake network: serves the client's metadata document. */
const network =
  (doc: Record<string, unknown> = {}, at = CLIENT) =>
  async (url: string) => {
    if (url === at) {
      return new Response(
        JSON.stringify({
          client_id: at,
          client_name: 'Test Assistant',
          redirect_uris: ['http://127.0.0.1/callback', 'https://client.example/cb'],
          token_endpoint_auth_method: 'none',
          ...doc,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  };

async function pkce() {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = toBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  return { verifier, challenge };
}

async function authorize(
  h: H,
  opts: { scopes?: string[]; list_ids?: string[] | null; scope?: string } = {},
) {
  const { verifier, challenge } = await pkce();
  const q = {
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: opts.scope ?? 'someday:read someday:write someday:notify',
    state: 'xyz',
    resource: `${ORIGIN}/mcp`,
  };
  const info = await call(h, 'GET', `/api/oauth/authorize?${new URLSearchParams(q)}`);
  expect(info.ok).toBe(true);
  const r = await call(
    h,
    'POST',
    '/api/oauth/authorize',
    {
      ...q,
      decision: 'allow',
      granted_scopes: opts.scopes ?? ['someday:read', 'someday:write', 'someday:notify'],
      list_ids: opts.list_ids ?? null,
    },
    200,
  );
  const u = new URL(r.redirect);
  expect(u.searchParams.get('state')).toBe('xyz');
  expect(u.searchParams.get('iss')).toBe(ORIGIN);
  return { code: u.searchParams.get('code')!, verifier };
}

async function token(h: Harness, params: Record<string, string>) {
  const res = await h.fetch('/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://client.example',
    },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function connect(h: H, opts: Parameters<typeof authorize>[1] = {}) {
  const { code, verifier } = await authorize(h, opts);
  const t = await token(h, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    code_verifier: verifier,
    resource: `${ORIGIN}/mcp`,
  });
  expect(t.status).toBe(200);
  return t.body as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
}

/** A modern (2026-07-28) MCP request with the mirrored headers. */
async function mcp(
  h: Harness,
  accessToken: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const res = await h.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: 'https://client.example',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(params.name ? { 'mcp-name': String(params.name) } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      cookie: '',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: res.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : text,
  };
}

const tool = (h: Harness, t: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(h, t, 'tools/call', { name, arguments: args });

describe('OAuth metadata', () => {
  it('serves protected-resource and authorization-server metadata', async () => {
    const h = (await authed()) as H;
    const prm = await h.json('/.well-known/oauth-protected-resource');
    expect(prm.body).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ['someday:read', 'someday:write', 'someday:notify'],
    });
    expect((await h.json('/.well-known/oauth-protected-resource/mcp')).status).toBe(200);
    const as = (await h.json('/.well-known/oauth-authorization-server')).body;
    expect(as).toMatchObject({
      issuer: ORIGIN,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(as.registration_endpoint).toBeUndefined();
  });

  it('asks for a token with the resource metadata URL', async () => {
    const r = await mcp((await authed()) as H, null, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('authorization code flow', () => {
  it('rejects unknown clients and unregistered redirect URIs without redirecting', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const bad = await call(
      h,
      'GET',
      `/api/oauth/authorize?${new URLSearchParams({ client_id: CLIENT, redirect_uri: 'https://evil.example/cb', response_type: 'code' })}`,
    );
    expect(bad).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    const other = 'https://client.example/oauth/other.json';
    const h2 = (await authed({
      fetch: network({ client_id: 'https://elsewhere.example/x.json' }, other),
    })) as H;
    const mismatch = await call(
      h2,
      'GET',
      `/api/oauth/authorize?${new URLSearchParams({ client_id: other, redirect_uri: REDIRECT })}`,
    );
    expect(mismatch).toMatchObject({ ok: false, error: 'invalid_client' });
  });

  it('requires PKCE S256 (reported through the redirect)', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const r = await call(
      h,
      'GET',
      `/api/oauth/authorize?${new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'x', code_challenge_method: 'plain' })}`,
    );
    expect(new URL(r.redirect).searchParams.get('error')).toBe('invalid_request');
  });

  it('describes the client on the consent screen, with a localhost warning', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { challenge } = await pkce();
    const r = await call(
      h,
      'GET',
      `/api/oauth/authorize?${new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' })}`,
    );
    expect(r).toMatchObject({
      ok: true,
      client: { client_name: 'Test Assistant' },
      redirect_host: '127.0.0.1:33418',
      localhost: true,
      scopes: ['someday:read', 'someday:write', 'someday:notify'],
    });
  });

  it('exchanges a code once, with the right verifier', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { code, verifier } = await authorize(h);
    const base = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT,
    };
    expect((await token(h, { ...base, code_verifier: 'x'.repeat(43) })).body.error).toBe(
      'invalid_grant',
    );
    const ok = await token(h, { ...base, code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    const again = await token(h, { ...base, code_verifier: verifier });
    expect(again.body.error).toBe('invalid_grant');
    // Replaying the code revoked what it had issued.
    expect((await mcp(h, ok.body.access_token, 'tools/list')).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const t1 = await connect(h);
    const t2 = await token(h, {
      grant_type: 'refresh_token',
      refresh_token: t1.refresh_token,
      client_id: CLIENT,
    });
    expect(t2.status).toBe(200);
    expect((await mcp(h, t2.body.access_token, 'tools/list')).status).toBe(200);
    const reuse = await token(h, {
      grant_type: 'refresh_token',
      refresh_token: t1.refresh_token,
      client_id: CLIENT,
    });
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await mcp(h, t2.body.access_token, 'tools/list')).status).toBe(401);
  });

  it('expires access tokens after an hour; revoking the connection kills them', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const t = await connect(h);
    const [grant] = await call(h, 'GET', '/api/oauth/grants');
    expect(grant).toMatchObject({
      client_name: 'Test Assistant',
      scopes: ['someday:read', 'someday:write', 'someday:notify'],
      lists: null,
    });
    await call(h, 'DELETE', `/api/oauth/grants/${grant.id}`, undefined, 200);
    expect((await mcp(h, t.access_token, 'tools/list')).status).toBe(401);
    const t2 = await connect(h);
    h.clock.advance(HOUR + 1);
    expect((await mcp(h, t2.access_token, 'tools/list')).status).toBe(401);
  });

  it('offers DCR only when MCP_ALLOW_DCR is on', async () => {
    const off = (await authed()) as H;
    expect(
      (await off.json('/oauth/register', { method: 'POST', json: { redirect_uris: [REDIRECT] } }))
        .status,
    ).toBe(404);
    const on = (await authed({ env: { MCP_ALLOW_DCR: 'true' } })) as H;
    const r = await on.json('/oauth/register', {
      method: 'POST',
      json: { redirect_uris: [REDIRECT], client_name: 'DCR app' },
    });
    expect(r.status).toBe(201);
    expect(r.body.client_id).toMatch(/^dcr_/);
    expect(
      (await on.json('/.well-known/oauth-authorization-server')).body.registration_endpoint,
    ).toBe(`${ORIGIN}/oauth/register`);
    expect(
      (
        await on.json('/oauth/register', {
          method: 'POST',
          json: { redirect_uris: ['http://evil.example/cb'] },
        })
      ).status,
    ).toBe(400);
  });
});

describe('MCP protocol (2026-07-28)', () => {
  it('discovers, lists tools deterministically, and validates headers', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { access_token: t } = await connect(h);
    const d = await mcp(h, t, 'server/discover');
    expect(d.body.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'someday' } },
    });
    const list = await mcp(h, t, 'tools/list');
    expect(list.body.result.tools.map((x: { name: string }) => x.name)).toEqual([
      'list_lists',
      'search_items',
      'get_item',
      'suggest',
      'create_item',
      'update_item',
      'set_status',
      'log_done',
      'send_notification',
    ]);
    expect(list.body.result).toMatchObject({ ttlMs: expect.any(Number), cacheScope: 'public' });
    expect(list.body.result.tools[4].inputSchema).toMatchObject({
      type: 'object',
      required: ['title'],
    });

    const mismatch = await mcp(h, t, 'tools/list', {}, { 'mcp-method': 'tools/call' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(-32020);
    const noName = await mcp(
      h,
      t,
      'tools/call',
      { name: 'list_lists' },
      { 'mcp-name': 'search_items' },
    );
    expect(noName.body.error.code).toBe(-32020);
    const version = await mcp(h, t, 'tools/list', {}, { 'mcp-protocol-version': '2099-01-01' });
    expect(version.body.error.code).toBe(-32020);
    const unknown = await mcp(h, t, 'prompts/list');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(-32601);
    expect(
      (await h.fetch('/mcp', { method: 'GET', headers: { authorization: `Bearer ${t}` } })).status,
    ).toBe(405);
    const evil = await mcp(h, t, 'tools/list', {}, { origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
  });

  it('rejects an unsupported version with the supported list, and missing capabilities', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { access_token: t } = await connect(h);
    const res = await h.fetch('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2030-01-01',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2030-01-01',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatchObject({
      code: -32022,
      data: { requested: '2030-01-01' },
    });
    const res2 = await h.fetch('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    });
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as any).error.code).toBe(-32602);
  });

  it('serves legacy clients that start with initialize', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { access_token: t } = await connect(h);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      h.fetch('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const init = (await (
      await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'old', version: '1' },
        },
      })
    ).json()) as any;
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'someday' },
    });
    expect(
      (
        await post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { 'mcp-protocol-version': '2025-06-18' },
        )
      ).status,
    ).toBe(202);
    const tools = (await (
      await post(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { 'mcp-protocol-version': '2025-06-18' },
      )
    ).json()) as any;
    expect(tools.result.tools).toHaveLength(9);
    // Never mints a session.
    expect(
      (await post({ jsonrpc: '2.0', id: 3, method: 'ping' })).headers.get('mcp-session-id'),
    ).toBeNull();
  });

  it('acknowledges subscriptions/listen and closes it gracefully', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { access_token: t } = await connect(h);
    const r = await mcp(h, t, 'subscriptions/listen', {
      notifications: { toolsListChanged: true },
    });
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.body).toContain('notifications/subscriptions/acknowledged');
    expect(r.body).toContain('"io.modelcontextprotocol/subscriptionId":1');
  });
});

describe('tools', () => {
  it('create, search, get, suggest, update, set_status and log_done, recorded "via" the client', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { access_token: t } = await connect(h);
    const created = await tool(h, t, 'create_item', {
      title: 'Visit Svalbard',
      duration: 'trip',
      tags: ['Arctic'],
    });
    expect(created.body.result.isError).toBeUndefined();
    const id = created.body.result.structuredContent.item.id;
    expect(created.body.result.structuredContent.item).toMatchObject({
      title: 'Visit Svalbard',
      duration: 'trip',
      tags: ['arctic'],
      list_id: h.user.defaultListId,
    });
    expect(created.body.result.content[0].text).toContain('Visit Svalbard');

    const found = await tool(h, t, 'search_items', { text: 'svalbard', max_duration: 'trip' });
    expect(found.body.result.structuredContent.items).toHaveLength(1);
    expect(
      (await tool(h, t, 'search_items', { max_duration: 'day' })).body.result.structuredContent
        .items,
    ).toHaveLength(0);

    const s = await tool(h, t, 'suggest', {});
    expect(s.body.result.structuredContent.suggestion.reasons.length).toBeGreaterThan(0);

    await tool(h, t, 'update_item', { id, notes: 'Midnight sun in June' });
    await tool(h, t, 'set_status', { id, status: 'planned' });
    const logged = await tool(h, t, 'log_done', { item_id: id, note: 'Cold!' });
    expect(logged.body.result.structuredContent.entry).toMatchObject({
      done_on: '2026-10-15',
      visibility: 'private',
    });
    const got = await tool(h, t, 'get_item', { id });
    expect(got.body.result.structuredContent.item).toMatchObject({
      status: 'done',
      notes: 'Midnight sun in June',
      done_for_me: true,
    });

    const history = await call(h, 'GET', `/api/items/${id}/history`);
    expect(history[0]).toMatchObject({ by: 'Test User', via: 'Test Assistant' });

    const lists = await tool(h, t, 'list_lists');
    expect(lists.body.result.structuredContent.lists[0]).toMatchObject({
      name: 'Someday',
      role: 'owner',
    });
  });

  it('reports bad arguments and missing items as tool errors the model can read', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { access_token: t } = await connect(h);
    const bad = await tool(h, t, 'create_item', { title: '' });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/Invalid arguments/);
    const missing = await tool(h, t, 'get_item', { id: '01JNOPE0000000000000000000' });
    expect(missing.body.result).toMatchObject({ isError: true });
    expect((await tool(h, t, 'no_such_tool')).body.error.code).toBe(-32602);
  });

  it('enforces scopes: a read-only connection cannot write', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const { access_token: t } = await connect(h, { scopes: ['someday:read'] });
    const r = await tool(h, t, 'create_item', { title: 'x' });
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(r.headers.get('www-authenticate')).toContain('scope="someday:write"');
    expect((await tool(h, t, 'list_lists')).status).toBe(200);
    expect((await tool(h, t, 'send_notification', { title: 'a', body: 'b' })).status).toBe(403);
  });

  it('a connection restricted to some lists sees and touches only those', async () => {
    const h = (await authed({ fetch: network() })) as H;
    const other = await call(h, 'POST', '/api/lists', { name: 'Private' }, 201);
    await call(h, 'POST', '/api/items', { list_id: other.id, title: 'Secret plan' }, 201);
    await call(h, 'POST', '/api/items', { list_id: h.user.defaultListId, title: 'Open plan' }, 201);
    const { access_token: t } = await connect(h, { list_ids: [h.user.defaultListId] });
    const items = (await tool(h, t, 'search_items', {})).body.result.structuredContent.items;
    expect(items.map((i: { title: string }) => i.title)).toEqual(['Open plan']);
    expect((await tool(h, t, 'list_lists')).body.result.structuredContent.lists).toHaveLength(1);
    const w = await tool(h, t, 'create_item', { title: 'x', list_id: other.id });
    expect(w.body.result.isError).toBe(true);
  });

  it("never exposes another user's data", async () => {
    const h = (await authed({ fetch: network() })) as H;
    const stranger = (await otherUser(h, 'Stranger')) as H;
    const theirs = await call(
      stranger,
      'POST',
      '/api/items',
      { list_id: stranger.user.defaultListId, title: 'Theirs' },
      201,
    );
    const { access_token: t } = await connect(h);
    expect((await tool(h, t, 'get_item', { id: theirs.id })).body.result.isError).toBe(true);
    expect(
      (await tool(h, t, 'search_items', { text: 'Theirs' })).body.result.structuredContent.items,
    ).toEqual([]);
    expect(
      (await tool(h, t, 'update_item', { id: theirs.id, title: 'pwned' })).body.result.isError,
    ).toBe(true);
  });

  it('send_notification respects the daily cap', async () => {
    const h = (await authed({ fetch: network(), env: { AGENT_NOTIFY_DAILY_MAX: '1' } })) as H;
    await call(h, 'PATCH', '/api/settings', { quiet_start: '00:00', quiet_end: '00:00' }, 200);
    const { access_token: t } = await connect(h);
    expect(
      (await tool(h, t, 'send_notification', { title: 'Hi', body: 'There' })).body.result
        .structuredContent.status,
    ).toBe('sent');
    expect(
      (await tool(h, t, 'send_notification', { title: 'Hi', body: 'Again' })).body.result
        .structuredContent.status,
    ).toBe('limit');
    h.clock.advance(DAY);
  });
});
