// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authentication for /api/* (§2): every path needs a valid passkey session,
 * except the public paths modules declare (login, signup, health). OAuth
 * access tokens are only accepted on /mcp, never here.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from '../../core/errors';
import type { AppEnv, AuthInfo } from '../types';
import { readSession } from './session';

const MUST_REGISTER_ALLOWED = new Set([
  '/api/auth/status',
  '/api/auth/register/options',
  '/api/auth/register/verify',
  '/api/auth/logout',
]);

/** Sensitive actions need a passkey assertion within this window (§2.1). */
export const REAUTH_WINDOW_MS = 5 * 60_000;

export function authenticate(publicPaths: Set<string>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = await readSession(c);
    c.set('auth', auth);
    const isPublic = publicPaths.has(c.req.path);
    if (!auth && !isPublic) {
      return c.json({ error: 'unauthorized', message: 'Login required' }, 401);
    }
    // A recovery-code session may only register a new passkey (or log out).
    if (auth?.mustRegister && !isPublic && !MUST_REGISTER_ALLOWED.has(c.req.path)) {
      return c.json({ error: 'must_register', message: 'Register a new passkey to continue' }, 403);
    }
    await next();
  };
}

export type SessionAuth = Extract<AuthInfo, { kind: 'session' }>;

/** The logged-in session (throws 401 when missing; routes behind authenticate always have one). */
export function sessionOf(c: Context<AppEnv>): SessionAuth {
  const a = c.get('auth');
  if (a?.kind !== 'session') throw new HttpError(401, 'unauthorized', 'Login required');
  return a;
}

export function userIdOf(c: Context<AppEnv>): string {
  return sessionOf(c).userId;
}

/** Throws 403 `reauth_required` unless the session asserted a passkey within 5 minutes. */
export function requireFreshAuth(c: Context<AppEnv>): SessionAuth {
  const s = sessionOf(c);
  if (s.reauthAt === null || c.env.ctx.clock.now() - s.reauthAt > REAUTH_WINDOW_MS) {
    throw new HttpError(403, 'reauth_required', 'Confirm with your passkey to do this');
  }
  return s;
}

export function requireAdmin(c: Context<AppEnv>): SessionAuth {
  const s = sessionOf(c);
  if (s.role !== 'admin') throw new HttpError(403, 'forbidden', 'Admins only');
  return s;
}
