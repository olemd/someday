// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rate limiting on Cloudflare (§9). The Workers Rate Limiting binding fixes
 * limit and period (10 s or 60 s) per binding in wrangler config, so it
 * cannot express per-call limits like "5 registrations per hour"; a D1
 * fixed-window counter can, and costs one statement per check.
 */
import type { Db, RateLimiter } from '../../core/ports';

export function d1RateLimiter(db: Db, nowMs: () => number): RateLimiter {
  return async (key, limit, windowSec) => {
    const windowStart = Math.floor(nowMs() / 1000 / windowSec) * windowSec;
    const row = await db.first<{ count: number }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
      `${key}:${windowSec}`,
      windowStart,
    );
    return (row?.count ?? 1) <= limit;
  };
}
