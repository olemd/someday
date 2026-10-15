// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Ports: the only way domain code and modules talk to the outside world
 * (SPEC §1.1). Nothing in src/core or src/modules imports Cloudflare or Bun
 * APIs; the adapters live in src/platform/{cloudflare,bun}/.
 */

export type SqlValue = string | number | null | Uint8Array | ArrayBuffer;

/** A prepared statement description: SQL with `?` placeholders and its parameters. */
export interface Stmt {
  sql: string;
  params: SqlValue[];
}

export interface RunResult {
  /** Rows changed by the statement. */
  changes: number;
  /** rowid of the last inserted row (0 if none). */
  lastRowId: number;
}

export interface BatchResult<T = Record<string, unknown>> extends RunResult {
  rows: T[];
}

/** The D1 API subset we use, shaped so the same SQL runs on D1 and bun:sqlite. */
export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  run(sql: string, ...params: SqlValue[]): Promise<RunResult>;
  /**
   * Run statements atomically in one transaction (D1 batch semantics: if any
   * statement fails, none are applied).
   */
  batch(stmts: Stmt[]): Promise<BatchResult[]>;
}

/** Shorthand for building a Stmt. */
export function stmt(sql: string, ...params: SqlValue[]): Stmt {
  return { sql, params };
}

export interface Clock {
  /** Current time as epoch milliseconds. */
  now(): number;
}

/** ISO 8601 UTC string for an epoch-ms instant (the storage format for datetimes). */
export const iso = (ms: number): string => new Date(ms).toISOString();

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Keeps background work alive after the response is sent (ctx.waitUntil on Workers). */
export interface Scheduler {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Rate limiting (§9): true if the action identified by `key` is allowed
 * (and counts it), false when `limit` actions already happened in the
 * current `windowSec` window.
 */
export type RateLimiter = (key: string, limit: number, windowSec: number) => Promise<boolean>;

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSender {
  /** Encrypts and delivers one payload. Returns the push service's HTTP status. */
  send(
    sub: PushSubscriptionKeys,
    payload: string,
    opts?: { ttl?: number; urgency?: string },
  ): Promise<number>;
}

/** Outbound HTTP (fetching OAuth client metadata documents). Swappable in tests. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const systemClock: Clock = { now: () => Date.now() };

/** Structured JSON logs (§9). Never pass item content here. */
export const consoleLogger: Logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: 'warn', msg, ...data })),
  error: (msg, data) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
};
