// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test harness: calls the Hono app directly with a controllable clock, so
 * time-dependent rules (sessions, links, windows, nudges) are deterministic.
 */
import { parseConfig } from '../src/core/config';
import { randomToken, tokenHash } from '../src/core/crypto';
import { type Clock, iso, type Logger, type PushSender } from '../src/core/ports';
import { ulid } from '../src/core/ulid';
import { createApp } from '../src/modules/app';
import { modules } from '../src/modules';
import { newUserStmts } from '../src/modules/data/users';
import type { Ctx } from '../src/modules/types';
// Resolved per test platform (D1 or SQLite) by the vitest config.
import { db, makeRateLimiter, testEnv } from '@test/platform';

export const ORIGIN = 'https://someday.test';
export { db };

/** 2026-10-15T10:00:00Z, a Thursday. */
export const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export class TestClock implements Clock {
  constructor(public t = T0) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

/**
 * One rate limiter per clock, like one per process in production: harnesses
 * sharing a clock (several clients of one server) share the counters.
 */
const limiters = new WeakMap<TestClock, Ctx['rateLimit']>();
function limiterFor(clock: TestClock) {
  let l = limiters.get(clock);
  if (!l) {
    l = makeRateLimiter(() => clock.now());
    limiters.set(clock, l);
  }
  return l;
}

export const quietLogger: Logger = { info() {}, warn() {}, error() {} };

export interface Harness {
  ctx: Ctx;
  clock: TestClock;
  pending: Promise<unknown>[];
  /** Fetch with cookie jar + same-origin headers. */
  fetch(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  json<T = any>(
    path: string,
    init?: RequestInit & { json?: unknown },
  ): Promise<{ status: number; body: T }>;
  cookie: string | null;
  userId: string | null;
  settle(): Promise<void>;
}

export interface HarnessOpts {
  push?: PushSender | null;
  now?: number;
  env?: Record<string, string>;
  fetch?: Ctx['fetch'];
  clock?: TestClock;
}

export function harness(opts: HarnessOpts = {}): Harness {
  const clock = opts.clock ?? new TestClock(opts.now);
  const pending: Promise<unknown>[] = [];
  const scheduler = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const parsed = parseConfig({ ...testEnv, ...opts.env });
  const ctx: Ctx = {
    db,
    config: parsed.config,
    configErrors: parsed.errors,
    clock,
    log: quietLogger,
    scheduler,
    rateLimit: limiterFor(clock),
    push: opts.push ?? null,
    fetch: opts.fetch ?? (async () => new Response('no network in tests', { status: 599 })),
    // Tests simulate client IPs with this header.
    clientIp: (req) => req.headers.get('cf-connecting-ip') ?? 'unknown',
  };
  const app = createApp(modules);
  const h: Harness = {
    ctx,
    clock,
    pending,
    cookie: null,
    userId: null,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has('origin')) headers.set('origin', ORIGIN);
      if (h.cookie && !headers.has('cookie')) headers.set('cookie', h.cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const res = await app.fetch(new Request(ORIGIN + path, { ...init, headers, body }), { ctx }, {
        waitUntil: scheduler.waitUntil,
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext);
      for (const set of res.headers.getSetCookie?.() ?? []) {
        const m = set.match(/__Host-session=([^;]*)/);
        if (m) h.cookie = m[1] ? `__Host-session=${m[1]}` : null;
      }
      return res;
    },
    async json(path, init) {
      const res = await h.fetch(path, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
  return h;
}

/** Delete all rows from all app tables. */
export async function resetDb() {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
  );
  // Users last-but-cascading: deleting users cascades to most tables, but do
  // every table explicitly so nothing leaks between tests.
  const names = tables.map((t) => t.name).filter((n) => n !== 'users');
  await db.batch([
    { sql: 'PRAGMA defer_foreign_keys = ON', params: [] },
    ...names.map((n) => ({ sql: `DELETE FROM "${n}"`, params: [] })),
    { sql: 'DELETE FROM users', params: [] },
  ]);
}

/** Create a user directly in the database (the signup flow has its own tests). */
export async function createUser(
  ctx: Ctx,
  opts: { name?: string; role?: 'admin' | 'user'; settings?: Record<string, unknown> } = {},
): Promise<{ id: string; defaultListId: string }> {
  const id = ulid(ctx.clock.now());
  await ctx.db.batch(
    newUserStmts(ctx, {
      id,
      displayName: opts.name ?? 'Test User',
      role: opts.role ?? 'user',
      handle: randomToken(16),
      settings: opts.settings ?? {},
    }),
  );
  const list = await ctx.db.first<{ list_id: string }>(
    "SELECT list_id FROM list_members WHERE user_id = ? AND role = 'owner'",
    id,
  );
  return { id, defaultListId: list!.list_id };
}

/** Log `h` in as `userId` with a session inserted directly. `fresh` = recent passkey assertion. */
export async function loginAs(h: Harness, userId: string, opts: { fresh?: boolean } = {}) {
  const token = randomToken(32);
  const now = h.clock.now();
  await db.run(
    `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, reauth_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, 'test')`,
    await tokenHash(h.ctx.config.TOKEN_PEPPER, token),
    userId,
    iso(now),
    iso(now + 90 * DAY),
    iso(now),
    opts.fresh ? iso(now) : null,
  );
  h.cookie = `__Host-session=${token}`;
  h.userId = userId;
  return h;
}

/** A harness logged in as a new user. */
export async function authed(
  opts: HarnessOpts & { name?: string; role?: 'admin' | 'user'; fresh?: boolean } = {},
) {
  const h = harness(opts);
  const u = await createUser(h.ctx, { name: opts.name, role: opts.role });
  await loginAs(h, u.id, { fresh: opts.fresh });
  return Object.assign(h, { user: u });
}

/** A second harness for another user, sharing the first one's clock. */
export async function otherUser(h: Harness, name = 'Other') {
  return authed({ clock: h.clock, name });
}

/** POST/PATCH/DELETE shorthands that assert the expected status. */
export async function call<T = any>(
  h: Harness,
  method: string,
  path: string,
  json?: unknown,
  expectStatus?: number,
): Promise<T> {
  const r = await h.json<T>(path, { method, ...(json !== undefined ? { json } : {}) });
  if (expectStatus !== undefined && r.status !== expectStatus) {
    throw new Error(
      `${method} ${path} → ${r.status} (expected ${expectStatus}): ${JSON.stringify(r.body)}`,
    );
  }
  return r.body;
}
