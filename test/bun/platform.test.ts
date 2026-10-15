// SPDX-License-Identifier: AGPL-3.0-or-later
// Bun-only: the self-hosted server pieces (static files, client IP, migrations, runtime).
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientIpFrom,
  inCidrs,
  parseCidrs,
  parseIp,
  readServerEnv,
  resolveFileSecrets,
} from '../../src/platform/bun/env';
import { memoryRateLimiter } from '../../src/platform/bun/ratelimit';
import { applyMigrations } from '../../src/platform/bun/migrate';
import { createRuntime } from '../../src/platform/bun/runtime';
import { openDatabase, sqliteDb } from '../../src/platform/bun/sqlite';
import { createStaticHandler, parseHeadersFile } from '../../src/platform/bun/static';
import { TEST_ENV } from '../test-env';

let web: string;
beforeAll(() => {
  // A miniature dist/web: index.html, one hashed asset, sw.js and the _headers file.
  web = mkdtempSync(join(tmpdir(), 'someday-web-'));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(web, 'assets', 'main-abc.js'), 'console.log(1)');
  writeFileSync(join(web, 'sw.js'), '// sw');
  writeFileSync(join(web, '.env'), 'SECRET=1');
  writeFileSync(
    join(web, '_headers'),
    "# comment\n/*\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: default-src 'self'\n\n/sw.js\n  Cache-Control: no-cache\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
  );
});
afterAll(() => rmSync(web, { recursive: true, force: true }));

const get = (path: string, method = 'GET') => new Request(`https://x.test${path}`, { method });

describe('static files (same rules as Workers Static Assets)', () => {
  it('parses the _headers subset', () => {
    expect(parseHeadersFile('/a\n  K: v\n# c\n/b/*\n  X: y: z\n')).toEqual([
      { pattern: '/a', headers: [['K', 'v']] },
      { pattern: '/b/*', headers: [['X', 'y: z']] },
    ]);
  });

  it('serves files with headers from _headers', async () => {
    const serve = createStaticHandler(web);
    const js = serve(get('/assets/main-abc.js'));
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(serve(get('/sw.js')).headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for app routes, with security headers', async () => {
    const res = createStaticHandler(web)(get('/lists/abc'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('shell');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  it('with the real _headers, the app shell is always revalidated and assets are immutable', () => {
    const real = mkdtempSync(join(tmpdir(), 'someday-web-'));
    try {
      mkdirSync(join(real, 'assets'));
      writeFileSync(join(real, 'index.html'), '<!doctype html><title>shell</title>');
      writeFileSync(join(real, 'assets', 'main-abc.js'), 'console.log(1)');
      writeFileSync(join(real, '_headers'), readFileSync('src/web/public/_headers', 'utf8'));
      const serve = createStaticHandler(real);
      for (const path of ['/', '/index.html', '/lists/abc'])
        expect(serve(get(path)).headers.get('cache-control'), path).toBe('no-cache');
      expect(serve(get('/assets/main-abc.js')).headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('returns 404 no-store for missing hashed assets (never the SPA page)', () => {
    const res = createStaticHandler(web)(get('/assets/main-old.js'));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('never serves _headers, dotfiles or files outside the build directory', async () => {
    const serve = createStaticHandler(web);
    // Each of these gets the app shell instead of the file it asks for.
    for (const p of [
      '/_headers',
      '/.env',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/x/../../../etc/hosts',
    ]) {
      const body = await serve(get(p)).text();
      expect(body, p).toContain('shell');
      expect(body, p).not.toMatch(/SECRET|Cache-Control|root:/);
    }
  });

  it('only allows GET and HEAD', () => {
    const serve = createStaticHandler(web);
    expect(serve(get('/', 'HEAD')).status).toBe(200);
    expect(serve(get('/', 'POST')).status).toBe(405);
  });
});

describe('client IP', () => {
  const req = (xff?: string) =>
    new Request('https://x.test/', { headers: xff ? { 'x-forwarded-for': xff } : {} });
  const proxies = parseCidrs('127.0.0.1, 10.88.0.0/16, ::1');

  it('uses the socket address when no proxy is trusted, whatever the headers say', () => {
    expect(clientIpFrom(req('6.6.6.6'), '10.0.0.5', [])).toBe('10.0.0.5');
  });

  it('ignores X-Forwarded-For from a client that is not a trusted proxy', () => {
    // Someone reaching the port directly cannot pick their own address.
    expect(clientIpFrom(req('1.2.3.4'), '203.0.113.50', proxies)).toBe('203.0.113.50');
  });

  it('behind trusted proxies, takes the right-most untrusted hop', () => {
    expect(clientIpFrom(req('203.0.113.9'), '10.88.0.2', proxies)).toBe('203.0.113.9');
    // Fake entries a client prepends are to the left and never reached.
    expect(clientIpFrom(req('6.6.6.6, 203.0.113.9'), '127.0.0.1', proxies)).toBe('203.0.113.9');
    // Chained trusted proxies are skipped.
    expect(clientIpFrom(req('203.0.113.9, 10.88.0.7'), '10.88.0.2', proxies)).toBe('203.0.113.9');
    expect(clientIpFrom(req('2001:db8::5'), '::1', proxies)).toBe('2001:db8::5');
    expect(clientIpFrom(req(), '127.0.0.1', proxies)).toBe('127.0.0.1');
  });

  it('handles IPv4-mapped IPv6 socket addresses', () => {
    expect(clientIpFrom(req('203.0.113.9'), '::ffff:127.0.0.1', proxies)).toBe('203.0.113.9');
  });

  it('parses IPs and CIDRs, and rejects typos loudly', () => {
    expect(inCidrs('10.88.200.1', proxies)).toBe(true);
    expect(inCidrs('10.89.0.1', proxies)).toBe(false);
    expect(inCidrs('2001:db8::1', parseCidrs('2001:db8::/32'))).toBe(true);
    expect(inCidrs('2001:db9::1', parseCidrs('2001:db8::/32'))).toBe(false);
    expect(parseIp('300.1.1.1')).toBeNull();
    expect(parseIp('not-an-ip')).toBeNull();
    expect(() => parseCidrs('10.0.0.0/33')).toThrow(/TRUSTED_PROXIES/);
    expect(() => parseCidrs('localhost')).toThrow(/TRUSTED_PROXIES/);
  });

  it('reads server settings with safe defaults', () => {
    expect(readServerEnv({})).toMatchObject({ port: 8080, host: '127.0.0.1', trustedProxies: [] });
    expect(
      readServerEnv({ TRUSTED_PROXIES: '127.0.0.1', PORT: '9000' }).trustedProxies,
    ).toHaveLength(1);
  });

  it('reads *_FILE secrets; an explicit value wins', () => {
    const files: Record<string, string> = { '/run/secrets/p': 'from-file\n' };
    const read = (p: string) => files[p]!;
    expect(resolveFileSecrets({ TOKEN_PEPPER_FILE: '/run/secrets/p' }, read).TOKEN_PEPPER).toBe(
      'from-file',
    );
    expect(
      resolveFileSecrets({ TOKEN_PEPPER: 'env', TOKEN_PEPPER_FILE: '/run/secrets/p' }, read)
        .TOKEN_PEPPER,
    ).toBe('env');
  });
});

describe('in-memory rate limiter', () => {
  it('counts per key and window', async () => {
    let now = 0;
    const limit = memoryRateLimiter(() => now);
    expect(await limit('a', 2, 60)).toBe(true);
    expect(await limit('a', 2, 60)).toBe(true);
    expect(await limit('a', 2, 60)).toBe(false);
    expect(await limit('b', 2, 60)).toBe(true);
    now = 61_000;
    expect(await limit('a', 2, 60)).toBe(true);
  });
});

describe('migrations', () => {
  it('applies every migration once and records it like wrangler does', () => {
    const sqlite = new Database(':memory:');
    const first = applyMigrations(sqlite, 'migrations');
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(applyMigrations(sqlite, 'migrations')).toEqual([]);
    const names = (
      sqlite.query('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(first);
  });
});

describe('SQLite adapter', () => {
  it('enforces foreign keys and rolls back a failing batch', async () => {
    const sqlite = openDatabase(':memory:');
    applyMigrations(sqlite, 'migrations');
    const db = sqliteDb(sqlite);
    await expect(
      db.run(
        "INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES ('x', 'y', 'owner', '')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    const ins = "INSERT INTO instance_settings (key, value) VALUES ('a', '1')";
    await expect(
      db.batch([
        { sql: ins, params: [] },
        { sql: ins, params: [] },
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.all('SELECT * FROM instance_settings')).toEqual([]);
    const [r] = await db.batch([
      {
        sql: "INSERT INTO changes (entity, entity_id, op, at) VALUES ('x', 'y', 'upsert', '') RETURNING seq",
        params: [],
      },
    ]);
    expect(r).toMatchObject({ changes: 1, rows: [{ seq: expect.any(Number) }] });
  });
});

describe('runtime', () => {
  it('serves the API and the app shell, and runs the cron hook', async () => {
    const sqlite = openDatabase(':memory:');
    applyMigrations(sqlite, 'migrations');
    const rt = createRuntime({
      sqlite,
      env: TEST_ENV,
      staticDir: web,
      log: { info() {}, warn() {}, error() {} },
    });
    expect(rt.configErrors).toEqual([]);
    const health = await rt.fetch(get('/api/health'), '127.0.0.1');
    expect(await health.json()).toEqual({
      status: 'ok',
      version: '9.9.9',
      git_sha: 'testsha',
      config_errors: [],
    });
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect((await rt.fetch(get('/api/settings'), '127.0.0.1')).status).toBe(401);
    expect(await (await rt.fetch(get('/healthz'), '127.0.0.1')).text()).toBe('ok');
    expect(await (await rt.fetch(get('/lists/x'), '127.0.0.1')).text()).toContain('shell');
    await rt.cron();
    await rt.drain();
  });
});
