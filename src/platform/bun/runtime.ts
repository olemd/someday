// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The self-hosted runtime: everything server.ts needs, without the network
 * listener, so tests can drive exactly the same code.
 *
 * It builds the same platform-agnostic `Ctx` as the Worker does, with SQLite
 * instead of D1 and in-memory rate limits, and tracks background work (push)
 * so a shutdown can wait for it.
 */
import type { Database } from 'bun:sqlite';
import { parseConfig } from '../../core/config';
import {
  type Clock,
  consoleLogger,
  type Fetcher,
  type Logger,
  systemClock,
} from '../../core/ports';
import { modules } from '../../modules';
import { createApp, isServerPath } from '../../modules/app';
import { runScheduled } from '../../modules/cron';
import { pushSenderFromConfig } from '../../modules/push/sender';
import type { Ctx } from '../../modules/types';
import { memoryRateLimiter } from './ratelimit';
import { sqliteDb } from './sqlite';
import { createStaticHandler } from './static';

export interface RuntimeOptions {
  sqlite: Database;
  env: Record<string, string | undefined>;
  staticDir: string;
  clock?: Clock;
  log?: Logger;
  fetch?: Fetcher;
}

export function createRuntime(opts: RuntimeOptions) {
  const parsed = parseConfig(opts.env);
  const db = sqliteDb(opts.sqlite);
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? consoleLogger;
  const push = pushSenderFromConfig(parsed.config, clock);
  const rateLimit = memoryRateLimiter(() => clock.now());
  const app = createApp(modules);
  const serveStatic = createStaticHandler(opts.staticDir);
  const pending = new Set<Promise<unknown>>();

  const scheduler = {
    waitUntil(p: Promise<unknown>) {
      const tracked = p.catch((err: unknown) =>
        log.error('background task failed', { err: String(err) }),
      );
      pending.add(tracked);
      void tracked.finally(() => pending.delete(tracked));
    },
  };

  function buildCtx(clientIp: string): Ctx {
    return {
      db,
      config: parsed.config,
      configErrors: parsed.errors,
      clock,
      log,
      scheduler,
      rateLimit,
      push,
      fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
      clientIp: () => clientIp,
    };
  }

  return {
    config: parsed.config,
    configErrors: parsed.errors,

    /** Handle one HTTP request; `clientIp` is resolved by the caller (socket or proxy). */
    async fetch(req: Request, clientIp: string): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (!isServerPath(pathname)) return serveStatic(req);
      const exec = { waitUntil: scheduler.waitUntil, passThroughOnException() {}, props: {} };
      return app.fetch(req, { ctx: buildCtx(clientIp) }, exec as never);
    },

    /** One run of the scheduled work (§1.1). */
    async cron(): Promise<void> {
      await runScheduled(buildCtx('cron'));
    },

    /** Wait for in-flight background work (push) before shutdown. */
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
