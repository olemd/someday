// SPDX-License-Identifier: AGPL-3.0-or-later
/** Rate limit helpers on top of the platform's RateLimiter port (§9). */
import type { Context } from 'hono';
import { HttpError } from '../core/errors';
import type { AppEnv, Ctx } from './types';

export async function limitOrThrow(
  ctx: Ctx,
  key: string,
  limit: number,
  windowSec: number,
): Promise<void> {
  if (!(await ctx.rateLimit(key, limit, windowSec))) {
    throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
  }
}

/** The per-IP limit shared by all unauthenticated auth endpoints. */
export function authLimit(c: Context<AppEnv>, bucket = 'auth'): Promise<void> {
  const ctx = c.env.ctx;
  return limitOrThrow(ctx, `${bucket}:${ctx.clientIp(c.req.raw)}`, ctx.config.AUTH_RATE_LIMIT, 600);
}
