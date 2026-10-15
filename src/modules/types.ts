// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The module contract. Every feature is a folder in src/modules/ exporting a
 * `Module`; they are registered explicitly in src/modules/index.ts.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppConfig } from '../core/config';
import type { Clock, Db, Fetcher, Logger, PushSender, RateLimiter, Scheduler } from '../core/ports';

/** Everything a request or cron run needs; built per invocation by the platform layer. */
export interface Ctx {
  db: Db;
  config: AppConfig;
  configErrors: string[];
  clock: Clock;
  log: Logger;
  scheduler: Scheduler;
  rateLimit: RateLimiter;
  /** null when VAPID keys are not configured. */
  push: PushSender | null;
  /** Outbound HTTP (OAuth client metadata documents). */
  fetch: Fetcher;
  /**
   * The client's IP address as the platform knows it (rate limits).
   * Cloudflare sets a header it controls; the self-hosted server uses the
   * socket or a trusted proxy header.
   */
  clientIp(req: Request): string;
}

export type Scope = 'someday:read' | 'someday:write' | 'someday:notify';

export type AuthInfo =
  | {
      kind: 'session';
      userId: string;
      role: 'admin' | 'user';
      idHash: string;
      passkeyId: string | null;
      /** Epoch ms of the last passkey assertion in this session, or null. */
      reauthAt: number | null;
      mustRegister: boolean;
    }
  | {
      kind: 'oauth';
      userId: string;
      role: 'admin' | 'user';
      tokenId: string;
      clientId: string;
      clientName: string;
      scopes: Scope[];
      /** Lists the grant is restricted to, or null for all. */
      listIds: string[] | null;
    };

export interface AppEnv {
  Bindings: { ctx: Ctx };
  Variables: { auth: AuthInfo | null };
}

export type Router = OpenAPIHono<AppEnv>;

export interface Module {
  name: string;
  /** Routes, mounted under /api/<name> unless `mountPath` says otherwise. */
  routes?: (app: Router) => void;
  mountPath?: string;
  /** Paths (relative to the mount, e.g. '/login/options') reachable without auth. */
  publicPaths?: string[];
  /** Run from the single cron trigger (every 15 min, §5). */
  cron?: (ctx: Ctx) => Promise<void>;
}
