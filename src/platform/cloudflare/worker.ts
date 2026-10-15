// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Worker entry point: builds a platform-agnostic `Ctx` from the Cloudflare
 * env and hands requests to the Hono app and cron runs to runScheduled.
 */
import { parseConfig, type ParsedConfig } from '../../core/config';
import { consoleLogger, systemClock } from '../../core/ports';
import { createApp, isServerPath } from '../../modules/app';
import { modules } from '../../modules';
import { runScheduled } from '../../modules/cron';
import { pushSenderFromConfig } from '../../modules/push/sender';
import type { Ctx } from '../../modules/types';
import { d1Db } from './d1';
import { d1RateLimiter } from './ratelimit';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

const app = createApp(modules);

/**
 * Hashed build assets must never fall back to the SPA's index.html: _headers
 * marks /assets/* immutable, so a stale page asking for an old hash would
 * cache HTML under a JS/CSS URL for a year.
 */
export function assetOr404(res: Response): Response {
  if (res.ok && res.headers.get('content-type')?.startsWith('text/html')) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return res;
}

// Config is parsed once per isolate; env does not change within an isolate.
let parsed: ParsedConfig | null = null;

export function buildCtx(env: Env, exec: { waitUntil(p: Promise<unknown>): void }): Ctx {
  parsed ??= parseConfig(env);
  const db = d1Db(env.DB);
  return {
    db,
    config: parsed.config,
    configErrors: parsed.errors,
    clock: systemClock,
    log: consoleLogger,
    scheduler: { waitUntil: (p) => exec.waitUntil(p) },
    rateLimit: d1RateLimiter(db, () => systemClock.now()),
    push: pushSenderFromConfig(parsed.config, systemClock),
    fetch: (url, init) => fetch(url, init),
    // Set by Cloudflare's edge on every request; clients cannot override it.
    clientIp: (req) => req.headers.get('cf-connecting-ip') ?? 'unknown',
  };
}

export default {
  async fetch(request, env, exec) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/assets/')) return assetOr404(await env.ASSETS.fetch(request));
    if (!isServerPath(url.pathname)) return env.ASSETS.fetch(request);
    return app.fetch(request, { ctx: buildCtx(env, exec) }, exec);
  },
  async scheduled(_controller, env, exec) {
    await runScheduled(buildCtx(env, exec));
  },
} satisfies ExportedHandler<Env>;
