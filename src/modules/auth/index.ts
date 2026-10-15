// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authentication (§2): passkeys only (WebAuthn, discoverable, user
 * verification required), recovery codes, sessions, registration.
 *
 * - Signup: `setup` (first admin, BOOTSTRAP_ADMIN_TOKEN, only while no admin
 *   exists), `invite` (single-use invite link) or `open` (REGISTRATION_MODE).
 * - Login: discoverable passkey, no username.
 * - Re-auth: a fresh assertion for sensitive actions (device links, account
 *   deletion, new recovery codes, adding passkeys).
 * - Recovery code: one login that may only register a new passkey.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { randomToken, timingSafeEqual, tokenHash } from '../../core/crypto';
import { HttpError, conflict, notFound } from '../../core/errors';
import { iso, type Stmt } from '../../core/ports';
import { SettingsSchema } from '../../core/settings';
import { ulid } from '../../core/ulid';
import { newUserStmts } from '../data/users';
import { body, json } from '../http';
import { adminExists, registrationMode } from '../instance';
import { notifyPasskeyAdded } from '../notices/service';
import { authLimit, limitOrThrow } from '../ratelimit';
import type { Ctx, Module, Router } from '../types';
import { requireFreshAuth, sessionOf } from './middleware';
import { newRecoveryCodes, redeemRecoveryCode } from './recovery';
import { clearSessionCookie, createSession, purgeExpired, sessionInsert } from './session';
import {
  authenticationOptions,
  passkeyInsert,
  registrationOptions,
  storeChallenge,
  verifyAssertion,
  verifyRegistration,
} from './webauthn';

const Ok = z.object({ ok: z.literal(true) });
const WebAuthnJSON = z.record(z.string(), z.unknown());
const Label = z.string().trim().min(1).max(100);

const PasskeySchema = z.object({
  id: z.string(),
  label: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  current: z.boolean(),
});

const SessionSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  user_agent: z.string(),
  current: z.boolean(),
});

const StatusSchema = z.object({
  authenticated: z.boolean(),
  must_register: z.boolean(),
  user: z
    .object({
      id: z.string(),
      display_name: z.string(),
      role: z.enum(['admin', 'user']),
      passkey_id: z.string().nullable(),
    })
    .nullable(),
  registration_mode: z.enum(['invite', 'open', 'closed']),
  setup_available: z.boolean(),
  push_public_key: z.string().nullable(),
});

const SignupOptions = z.object({
  kind: z.enum(['setup', 'invite', 'open']),
  token: z.string().max(200).optional(),
  display_name: z.string().trim().min(1).max(80),
});

const SignupVerify = z.object({
  response: WebAuthnJSON,
  label: Label.default('Passkey'),
  timezone: SettingsSchema.shape.timezone.optional(),
  locale: SettingsSchema.shape.locale.optional(),
});

interface SignupContext {
  user_id: string;
  handle: string;
  display_name: string;
  kind: 'setup' | 'invite' | 'open';
  invite_id: string | null;
}

async function findInvite(ctx: Ctx, token: string | undefined) {
  if (!token) return null;
  return ctx.db.first<{ id: string; created_by: string | null }>(
    'SELECT id, created_by FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    await tokenHash(ctx.config.TOKEN_PEPPER, token),
    iso(ctx.clock.now()),
  );
}

/** Check that a signup of this kind is allowed now; returns the invite when relevant. */
async function checkSignupAllowed(
  ctx: Ctx,
  kind: SignupContext['kind'],
  token: string | undefined,
): Promise<string | null> {
  if (kind === 'setup') {
    const expected = ctx.config.BOOTSTRAP_ADMIN_TOKEN;
    if (await adminExists(ctx)) throw new HttpError(403, 'setup_disabled', 'Setup is disabled');
    if (!expected || !token || !timingSafeEqual(token, expected)) {
      throw new HttpError(403, 'bad_setup_token', 'Invalid setup token');
    }
    return null;
  }
  const mode = await registrationMode(ctx);
  if (mode === 'closed') {
    throw new HttpError(403, 'registration_closed', 'Registration is closed');
  }
  if (kind === 'open') {
    if (mode !== 'open') throw new HttpError(403, 'invite_required', 'An invite is required');
    return null;
  }
  const invite = await findInvite(ctx, token);
  if (!invite) throw new HttpError(403, 'bad_invite', 'This invite is invalid or used');
  return invite.id;
}

function routes(app: Router) {
  // Public: tells the UI whether to show setup, login or the app.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/status',
      tags: ['auth'],
      responses: { 200: json(StatusSchema) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const auth = c.get('auth');
      const user =
        auth?.kind === 'session'
          ? await ctx.db.first<{ id: string; display_name: string; role: 'admin' | 'user' }>(
              'SELECT id, display_name, role FROM users WHERE id = ?',
              auth.userId,
            )
          : null;
      return c.json(
        {
          authenticated: !!user,
          must_register: auth?.kind === 'session' && auth.mustRegister,
          user: user
            ? { ...user, passkey_id: auth?.kind === 'session' ? auth.passkeyId : null }
            : null,
          registration_mode: await registrationMode(ctx),
          setup_available: !!ctx.config.BOOTSTRAP_ADMIN_TOKEN && !(await adminExists(ctx)),
          push_public_key: ctx.push ? (ctx.config.VAPID_PUBLIC_KEY ?? null) : null,
        },
        200,
      );
    },
  );

  // ── Signup ───────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'post',
      path: '/signup/options',
      tags: ['auth'],
      request: body(SignupOptions),
      responses: { 200: json(WebAuthnJSON) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      await authLimit(c);
      const { kind, token, display_name } = c.req.valid('json');
      const inviteId = await checkSignupAllowed(ctx, kind, token);
      const data: SignupContext = {
        user_id: ulid(ctx.clock.now()),
        handle: randomToken(16),
        display_name,
        kind,
        invite_id: inviteId,
      };
      const options = await registrationOptions(
        ctx,
        { handle: data.handle, name: display_name },
        null,
      );
      await storeChallenge(ctx, options.challenge, 'signup', null, { ...data });
      return c.json(options as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/signup/verify',
      tags: ['auth'],
      request: body(SignupVerify),
      responses: {
        200: json(z.object({ ok: z.literal(true), recovery_codes: z.array(z.string()) })),
      },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      await authLimit(c);
      const { response, label, timezone, locale } = c.req.valid('json');
      const reg = await verifyRegistration(ctx, response, 'signup', null);
      const s = reg.challenge.data as unknown as SignupContext;
      const now = iso(ctx.clock.now());

      // Re-check the rules that may have changed since the options call; the
      // batch gates below close the remaining races (two setups, one invite).
      if (s.kind === 'open') {
        if ((await registrationMode(ctx)) !== 'open') {
          throw new HttpError(403, 'invite_required', 'An invite is required');
        }
        await limitOrThrow(
          ctx,
          `signup:${ctx.clientIp(c.req.raw)}`,
          ctx.config.OPEN_REGISTRATIONS_PER_HOUR,
          3600,
        );
      }

      const stmts: Stmt[] = [];
      let gate: { sql: string; params: (string | number | null)[] } | undefined;
      if (s.kind === 'setup') {
        gate = { sql: "NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')", params: [] };
      } else if (s.kind === 'invite') {
        stmts.push({
          sql: 'UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?',
          params: [now, s.user_id, s.invite_id, now],
        });
        gate = {
          sql: 'EXISTS (SELECT 1 FROM invites WHERE id = ? AND used_by = ?)',
          params: [s.invite_id, s.user_id],
        };
      }
      const settings: Record<string, unknown> = {};
      if (timezone) settings.timezone = timezone;
      if (locale) settings.locale = locale;
      stmts.push(
        ...newUserStmts(
          ctx,
          {
            id: s.user_id,
            displayName: s.display_name,
            role: s.kind === 'setup' ? 'admin' : 'user',
            handle: s.handle,
            settings,
          },
          gate,
        ),
      );
      const userExists = { sql: 'EXISTS (SELECT 1 FROM users WHERE id = ?)', params: [s.user_id] };
      stmts.push(passkeyInsert(ctx, reg, s.user_id, label, userExists));
      const recovery = await newRecoveryCodes(ctx, s.user_id, userExists);
      stmts.push(...recovery.stmts);
      const session = await sessionInsert(c, {
        userId: s.user_id,
        passkeyId: reg.credentialId,
        fresh: true,
      });
      stmts.push(session.stmt);
      await ctx.db.batch(stmts);

      if (!(await ctx.db.first('SELECT 1 FROM users WHERE id = ?', s.user_id))) {
        throw s.kind === 'setup'
          ? new HttpError(403, 'setup_disabled', 'Setup is disabled')
          : new HttpError(403, 'bad_invite', 'This invite is invalid or used');
      }
      session.setCookie();
      ctx.log.info('user created', { user: s.user_id, kind: s.kind });
      return c.json({ ok: true as const, recovery_codes: recovery.codes }, 200);
    },
  );

  // ── Login ────────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'post',
      path: '/login/options',
      tags: ['auth'],
      responses: { 200: json(WebAuthnJSON) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      ctx.scheduler.waitUntil(purgeExpired(ctx));
      const options = await authenticationOptions(ctx, null);
      await storeChallenge(ctx, options.challenge, 'login', null);
      return c.json(options as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/login/verify',
      tags: ['auth'],
      request: body(z.object({ response: WebAuthnJSON })),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      await authLimit(c);
      const { passkeyId, userId } = await verifyAssertion(
        ctx,
        c.req.valid('json').response,
        'login',
        null,
      );
      await assertUserActive(ctx, userId);
      await createSession(c, { userId, passkeyId, fresh: true });
      return c.json({ ok: true as const }, 200);
    },
  );

  // ── Re-authentication for sensitive actions ─────────────────────────

  app.openapi(
    createRoute({
      method: 'post',
      path: '/reauth/options',
      tags: ['auth'],
      responses: { 200: json(WebAuthnJSON) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const { userId } = sessionOf(c);
      const options = await authenticationOptions(ctx, userId);
      await storeChallenge(ctx, options.challenge, 'reauth', userId);
      return c.json(options as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/reauth/verify',
      tags: ['auth'],
      request: body(z.object({ response: WebAuthnJSON })),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const s = sessionOf(c);
      await verifyAssertion(ctx, c.req.valid('json').response, 'reauth', s.userId);
      await ctx.db.run(
        'UPDATE sessions SET reauth_at = ? WHERE id_hash = ?',
        iso(ctx.clock.now()),
        s.idHash,
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  // ── Recovery ─────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'post',
      path: '/recovery',
      tags: ['auth'],
      request: body(z.object({ code: z.string().min(1).max(100) })),
      responses: { 200: json(z.object({ ok: z.literal(true), must_register: z.literal(true) })) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      await authLimit(c);
      const userId = await redeemRecoveryCode(ctx, c.req.valid('json').code);
      if (!userId) throw new HttpError(401, 'bad_recovery_code', 'Invalid or used recovery code');
      await assertUserActive(ctx, userId);
      await createSession(c, { userId, passkeyId: null, fresh: false, mustRegister: true });
      return c.json({ ok: true as const, must_register: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/recovery-codes',
      tags: ['auth'],
      responses: { 200: json(z.object({ remaining: z.number() })) },
    }),
    async (c) => {
      const r = await c.env.ctx.db.first<{ n: number }>(
        'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
        sessionOf(c).userId,
      );
      return c.json({ remaining: r?.n ?? 0 }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/recovery-codes',
      tags: ['auth'],
      responses: { 200: json(z.object({ recovery_codes: z.array(z.string()) })) },
    }),
    async (c) => {
      const s = requireFreshAuth(c);
      const { codes, stmts } = await newRecoveryCodes(c.env.ctx, s.userId);
      await c.env.ctx.db.batch(stmts);
      return c.json({ recovery_codes: codes }, 200);
    },
  );

  // ── Adding a passkey on this device (settings, or after recovery) ───

  app.openapi(
    createRoute({
      method: 'post',
      path: '/register/options',
      tags: ['auth'],
      responses: { 200: json(WebAuthnJSON) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const s = sessionOf(c);
      if (!s.mustRegister) requireFreshAuth(c);
      const user = await ctx.db.first<{ webauthn_handle: string; display_name: string }>(
        'SELECT webauthn_handle, display_name FROM users WHERE id = ?',
        s.userId,
      );
      if (!user) throw notFound();
      const options = await registrationOptions(
        ctx,
        { handle: user.webauthn_handle, name: user.display_name },
        s.userId,
      );
      await storeChallenge(ctx, options.challenge, 'register', s.userId);
      return c.json(options as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/register/verify',
      tags: ['auth'],
      request: body(z.object({ response: WebAuthnJSON, label: Label.default('Passkey') })),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const s = sessionOf(c);
      if (!s.mustRegister) requireFreshAuth(c);
      const { response, label } = c.req.valid('json');
      const reg = await verifyRegistration(ctx, response, 'register', s.userId);
      const stmts: Stmt[] = [passkeyInsert(ctx, reg, s.userId, label)];
      // Registering a passkey completes the recovery flow; the session now
      // belongs to the new passkey and counts as freshly authenticated.
      if (s.mustRegister) {
        stmts.push({
          sql: 'UPDATE sessions SET must_register = 0, passkey_id = ?, reauth_at = ? WHERE id_hash = ?',
          params: [reg.credentialId, iso(ctx.clock.now()), s.idHash],
        });
      }
      await ctx.db.batch(stmts);
      await notifyPasskeyAdded(ctx, s.userId, reg.credentialId, label);
      return c.json({ ok: true as const }, 200);
    },
  );

  // ── Passkeys ─────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'get',
      path: '/passkeys',
      tags: ['auth'],
      responses: { 200: json(z.array(PasskeySchema)) },
    }),
    async (c) => {
      const s = sessionOf(c);
      const rows = await c.env.ctx.db.all<Omit<z.infer<typeof PasskeySchema>, 'current'>>(
        'SELECT id, label, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at',
        s.userId,
      );
      return c.json(
        rows.map((r) => ({ ...r, current: r.id === s.passkeyId })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/passkeys/{id}',
      tags: ['auth'],
      request: {
        params: z.object({ id: z.string() }),
        ...body(z.object({ label: Label })),
      },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const r = await c.env.ctx.db.run(
        'UPDATE passkeys SET label = ? WHERE id = ? AND user_id = ?',
        c.req.valid('json').label,
        c.req.valid('param').id,
        sessionOf(c).userId,
      );
      if (r.changes === 0) throw notFound();
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/passkeys/{id}',
      tags: ['auth'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { db } = c.env.ctx;
      const { id } = c.req.valid('param');
      const s = sessionOf(c);
      // Never delete the last passkey: that would lock the user out. The
      // passkey's sessions go with it ("That wasn't me", §2.1).
      const [del] = await db.batch([
        {
          sql: `DELETE FROM passkeys WHERE id = ? AND user_id = ?
                  AND (SELECT COUNT(*) FROM passkeys WHERE user_id = ?) > 1`,
          params: [id, s.userId, s.userId],
        },
        {
          sql: `DELETE FROM sessions WHERE passkey_id = ? AND user_id = ?
                  AND NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?)`,
          params: [id, s.userId, id],
        },
      ]);
      if (del?.changes === 0) {
        const exists = await db.first(
          'SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?',
          id,
          s.userId,
        );
        if (!exists) throw notFound();
        throw conflict('last_passkey', 'Cannot delete the last passkey');
      }
      if (id === s.passkeyId) clearSessionCookie(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  // ── Sessions ─────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'get',
      path: '/sessions',
      tags: ['auth'],
      responses: { 200: json(z.array(SessionSchema)) },
    }),
    async (c) => {
      const s = sessionOf(c);
      const rows = await c.env.ctx.db.all<{
        id_hash: string;
        created_at: string;
        last_seen_at: string;
        user_agent: string;
      }>(
        `SELECT id_hash, created_at, last_seen_at, user_agent FROM sessions
          WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
        s.userId,
        iso(c.env.ctx.clock.now()),
      );
      return c.json(
        rows.map((r) => ({
          id: r.id_hash.slice(0, 16),
          created_at: r.created_at,
          last_seen_at: r.last_seen_at,
          user_agent: r.user_agent,
          current: r.id_hash === s.idHash,
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/sessions/{id}',
      tags: ['auth'],
      request: { params: z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const s = sessionOf(c);
      const { id } = c.req.valid('param');
      const r = await c.env.ctx.db.run(
        'DELETE FROM sessions WHERE user_id = ? AND substr(id_hash, 1, 16) = ?',
        s.userId,
        id,
      );
      if (r.changes === 0) throw notFound();
      if (s.idHash.startsWith(id)) clearSessionCookie(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/logout-others',
      tags: ['auth'],
      responses: { 200: json(z.object({ revoked: z.number() })) },
    }),
    async (c) => {
      const s = sessionOf(c);
      const r = await c.env.ctx.db.run(
        'DELETE FROM sessions WHERE user_id = ? AND id_hash != ?',
        s.userId,
        s.idHash,
      );
      return c.json({ revoked: r.changes }, 200);
    },
  );

  app.openapi(
    createRoute({ method: 'post', path: '/logout', tags: ['auth'], responses: { 200: json(Ok) } }),
    async (c) => {
      const auth = c.get('auth');
      if (auth?.kind === 'session') {
        await c.env.ctx.db.run('DELETE FROM sessions WHERE id_hash = ?', auth.idHash);
      }
      clearSessionCookie(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  // ── Profile ──────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/profile',
      tags: ['auth'],
      request: body(z.object({ display_name: z.string().trim().min(1).max(80) })),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      await c.env.ctx.db.run(
        'UPDATE users SET display_name = ? WHERE id = ?',
        c.req.valid('json').display_name,
        sessionOf(c).userId,
      );
      return c.json({ ok: true as const }, 200);
    },
  );
}

/** Disabled or deleted accounts cannot log in (§2.3, §7). */
export async function assertUserActive(ctx: Ctx, userId: string): Promise<void> {
  const u = await ctx.db.first<{ disabled_at: string | null; deleted_at: string | null }>(
    'SELECT disabled_at, deleted_at FROM users WHERE id = ?',
    userId,
  );
  if (!u || u.deleted_at) throw new HttpError(403, 'account_deleted', 'This account is deleted');
  if (u.disabled_at) throw new HttpError(403, 'account_disabled', 'This account is disabled');
}

export const authModule: Module = {
  name: 'auth',
  routes,
  publicPaths: [
    '/status',
    '/signup/options',
    '/signup/verify',
    '/login/options',
    '/login/verify',
    '/recovery',
    '/logout',
  ],
};
