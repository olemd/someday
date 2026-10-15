// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sessions (§2.1): an opaque random token in a `__Host-session` cookie
 * (HttpOnly, Secure, SameSite=Lax); the database stores only its peppered
 * hash. 90 days by default, sliding: every use (at most once an hour)
 * pushes the expiry out again.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomToken, tokenHash } from '../../core/crypto';
import { iso } from '../../core/ports';
import type { AppEnv, AuthInfo, Ctx } from '../types';

export const SESSION_COOKIE = '__Host-session';
/** Sliding renewal happens at most this often, to keep writes rare. */
const TOUCH_EVERY_MS = 3600_000;

function writeCookie(c: Context<AppEnv>, token: string, expiresAt: number) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

const ttlMs = (ctx: Ctx) => ctx.config.SESSION_TTL_DAYS * 86_400_000;

export interface NewSession {
  userId: string;
  passkeyId: string | null;
  /** The session was created by a passkey assertion just now (counts as re-auth). */
  fresh: boolean;
  mustRegister?: boolean;
}

/**
 * The SQL to insert a session, for callers that need it inside a batch. The
 * insert only happens if the user exists and the optional `gate` holds.
 */
export async function sessionInsert(
  c: Context<AppEnv>,
  s: NewSession,
  gate?: { sql: string; params: (string | number | null)[] },
) {
  const ctx = c.env.ctx;
  const token = randomToken(32);
  const now = ctx.clock.now();
  const expiresAt = now + ttlMs(ctx);
  return {
    token,
    expiresAt,
    stmt: {
      sql: `INSERT INTO sessions (id_hash, user_id, passkey_id, created_at, expires_at, last_seen_at,
              reauth_at, user_agent, must_register)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ${gate ? `AND ${gate.sql}` : ''}`,
      params: [
        await tokenHash(ctx.config.TOKEN_PEPPER, token),
        s.userId,
        s.passkeyId,
        iso(now),
        iso(expiresAt),
        iso(now),
        s.fresh ? iso(now) : null,
        (c.req.header('user-agent') ?? '').slice(0, 300),
        s.mustRegister ? 1 : 0,
        s.userId,
        ...(gate?.params ?? []),
      ],
    },
    /** Call after the statement succeeded. */
    setCookie: () => writeCookie(c, token, expiresAt),
  };
}

export async function createSession(c: Context<AppEnv>, s: NewSession): Promise<void> {
  const ins = await sessionInsert(c, s);
  await c.env.ctx.db.run(ins.stmt.sql, ...ins.stmt.params);
  ins.setCookie();
}

interface SessionRow {
  user_id: string;
  role: 'admin' | 'user';
  passkey_id: string | null;
  expires_at: string;
  last_seen_at: string;
  reauth_at: string | null;
  must_register: number;
}

/** Validates the cookie against an active, enabled user; slides the expiry. */
export async function readSession(
  c: Context<AppEnv>,
): Promise<Extract<AuthInfo, { kind: 'session' }> | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const ctx = c.env.ctx;
  const idHash = await tokenHash(ctx.config.TOKEN_PEPPER, token);
  const row = await ctx.db.first<SessionRow>(
    `SELECT s.user_id, u.role, s.passkey_id, s.expires_at, s.last_seen_at, s.reauth_at, s.must_register
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND u.disabled_at IS NULL AND u.deleted_at IS NULL`,
    idHash,
  );
  const now = ctx.clock.now();
  if (!row || Date.parse(row.expires_at) <= now) return null;
  if (now - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS) {
    const expiresAt = now + ttlMs(ctx);
    await ctx.db.run(
      'UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id_hash = ?',
      iso(expiresAt),
      iso(now),
      idHash,
    );
    writeCookie(c, token, expiresAt);
  }
  return {
    kind: 'session',
    userId: row.user_id,
    role: row.role,
    idHash,
    passkeyId: row.passkey_id,
    reauthAt: row.reauth_at ? Date.parse(row.reauth_at) : null,
    mustRegister: row.must_register === 1,
  };
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

/** Opportunistic cleanup of expired rows; cheap, set-based. */
export async function purgeExpired(ctx: Ctx): Promise<void> {
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    { sql: 'DELETE FROM sessions WHERE expires_at <= ?', params: [now] },
    { sql: 'DELETE FROM auth_challenges WHERE expires_at <= ?', params: [now] },
    {
      sql: 'DELETE FROM rate_limits WHERE window_start < ?',
      params: [Math.floor(ctx.clock.now() / 1000) - 86_400],
    },
  ]);
}
