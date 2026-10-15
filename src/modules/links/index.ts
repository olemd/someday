// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Device links (§2.1): add a passkey on another device with a one-time link,
 * QR code or short code, because platform passkeys do not sync across
 * ecosystems.
 *
 * 1. A logged-in user with a fresh passkey assertion creates a link (≤ 3
 *    active, DEVICE_LINK_TTL_MIN, token and code stored hashed).
 * 2. The new device claims it (link token or `XXXX-XXXX` code) and gets a
 *    claim token. With "require approval", it shows a 2-digit number that the
 *    originating device must pick among three.
 * 3. The new device runs a WebAuthn registration for the existing user. Only
 *    then is the link consumed and a session issued; an abandoned ceremony
 *    leaves the link usable until it expires.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  normalizeCrockford,
  randomCrockford,
  randomInt,
  randomToken,
  tokenHash,
} from '../../core/crypto';
import { HttpError, conflict, notFound } from '../../core/errors';
import { iso } from '../../core/ports';
import { ulid } from '../../core/ulid';
import { assertUserActive } from '../auth';
import { requireFreshAuth, sessionOf } from '../auth/middleware';
import { sessionInsert } from '../auth/session';
import {
  passkeyInsert,
  registrationOptions,
  storeChallenge,
  verifyRegistration,
} from '../auth/webauthn';
import { body, json } from '../http';
import { notifyPasskeyAdded, userSettings } from '../notices/service';
import { authLimit, limitOrThrow } from '../ratelimit';
import type { Ctx, Module, Router } from '../types';

export const MAX_ACTIVE_LINKS = 3;
export const MAX_CODE_ATTEMPTS = 5;
const CODE_LENGTH = 8;
const PREFIX_LENGTH = 3;
/** Global cap on claim attempts per 10 minutes, across all IPs. */
const GLOBAL_CLAIM_LIMIT = 300;

const Ok = z.object({ ok: z.literal(true) });
const WebAuthnJSON = z.record(z.string(), z.unknown());

const LinkSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  require_approval: z.boolean(),
  claimed: z.boolean(),
  approved: z.boolean(),
  /** Three numbers to pick from when a claim waits for approval. */
  approval_choices: z.array(z.number()).nullable(),
  claim_user_agent: z.string().nullable(),
});

interface LinkRow {
  id: string;
  user_id: string;
  code_hash: string;
  failed_attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  require_approval: number;
  claim_hash: string | null;
  approval_number: number | null;
  approval_choices: string | null;
  approved_at: string | null;
  claim_user_agent: string | null;
}

const ACTIVE = 'consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?';

const codeHash = (ctx: Ctx, code: string) =>
  tokenHash(ctx.config.TOKEN_PEPPER, `link-code:${code}`);

export const formatLinkCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Three distinct 2-digit numbers including `n`, in random order. */
function approvalChoices(n: number): number[] {
  const set = new Set([n]);
  while (set.size < 3) set.add(10 + randomInt(90));
  const out = [...set];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The active link a claim token refers to, or a 410/404 explaining why not. */
async function linkForClaim(ctx: Ctx, claim: string): Promise<LinkRow> {
  const link = await ctx.db.first<LinkRow>(
    'SELECT * FROM device_links WHERE claim_hash = ?',
    await tokenHash(ctx.config.TOKEN_PEPPER, claim),
  );
  if (!link) throw notFound('link_not_found');
  if (link.consumed_at || link.revoked_at || Date.parse(link.expires_at) <= ctx.clock.now()) {
    throw new HttpError(410, 'link_expired', 'This link has expired or was already used');
  }
  return link;
}

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['links'],
      responses: {
        200: json(
          z.object({
            id: z.string(),
            url: z.string(),
            code: z.string(),
            expires_at: z.string(),
            require_approval: z.boolean(),
          }),
        ),
      },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      // A hijacked session alone must not be able to mint a link.
      const s = requireFreshAuth(c);
      const now = ctx.clock.now();
      const active = await ctx.db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM device_links WHERE user_id = ? AND ${ACTIVE}`,
        s.userId,
        iso(now),
      );
      if ((active?.n ?? 0) >= MAX_ACTIVE_LINKS) {
        throw conflict('too_many_links', `At most ${MAX_ACTIVE_LINKS} active links`);
      }
      // The code's prefix must be unique among active links so a typed code
      // maps to exactly one link (failed attempts are counted per link).
      let code = '';
      for (let i = 0; i < 20 && !code; i++) {
        const candidate = randomCrockford(CODE_LENGTH);
        const clash = await ctx.db.first(
          `SELECT 1 FROM device_links WHERE code_prefix = ? AND ${ACTIVE}`,
          candidate.slice(0, PREFIX_LENGTH),
          iso(now),
        );
        if (!clash) code = candidate;
      }
      if (!code) throw new HttpError(503, 'try_again', 'Try again');
      const token = randomToken(32);
      const settings = await userSettings(ctx, s.userId);
      const id = ulid(now);
      const expiresAt = iso(now + ctx.config.DEVICE_LINK_TTL_MIN * 60_000);
      await ctx.db.run(
        `INSERT INTO device_links (id, user_id, token_hash, code_prefix, code_hash, created_at,
           expires_at, require_approval) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        s.userId,
        await tokenHash(ctx.config.TOKEN_PEPPER, token),
        code.slice(0, PREFIX_LENGTH),
        await codeHash(ctx, code),
        iso(now),
        expiresAt,
        settings.require_link_approval ? 1 : 0,
      );
      return c.json(
        {
          id,
          url: `${ctx.config.PUBLIC_ORIGIN}/link/${token}`,
          code: formatLinkCode(code),
          expires_at: expiresAt,
          require_approval: settings.require_link_approval,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['links'],
      responses: { 200: json(z.array(LinkSchema)) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const rows = await ctx.db.all<LinkRow>(
        `SELECT * FROM device_links WHERE user_id = ? AND ${ACTIVE} ORDER BY created_at`,
        sessionOf(c).userId,
        iso(ctx.clock.now()),
      );
      return c.json(
        rows.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          expires_at: r.expires_at,
          require_approval: r.require_approval === 1,
          claimed: r.claim_hash !== null,
          approved: r.approved_at !== null,
          approval_choices:
            r.require_approval === 1 && r.claim_hash && !r.approved_at && r.approval_choices
              ? (JSON.parse(r.approval_choices) as number[])
              : null,
          claim_user_agent: r.claim_user_agent,
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['links'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const r = await ctx.db.run(
        'UPDATE device_links SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
        iso(ctx.clock.now()),
        c.req.valid('param').id,
        sessionOf(c).userId,
      );
      if (r.changes === 0) throw notFound();
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/approve',
      tags: ['links'],
      request: {
        params: z.object({ id: z.string() }),
        ...body(z.object({ number: z.number().int().min(10).max(99) })),
      },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const now = iso(ctx.clock.now());
      const link = await ctx.db.first<LinkRow>(
        `SELECT * FROM device_links WHERE id = ? AND user_id = ? AND ${ACTIVE}`,
        c.req.valid('param').id,
        sessionOf(c).userId,
        now,
      );
      if (!link?.claim_hash || link.approval_number === null) throw notFound();
      if (link.approval_number !== c.req.valid('json').number) {
        // A wrong pick means someone else may be holding the link: kill it.
        await ctx.db.run('UPDATE device_links SET revoked_at = ? WHERE id = ?', now, link.id);
        throw conflict('wrong_number', 'That was not the number. The link has been cancelled.');
      }
      await ctx.db.run('UPDATE device_links SET approved_at = ? WHERE id = ?', now, link.id);
      return c.json({ ok: true as const }, 200);
    },
  );

  // ── New device (public) ──────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'post',
      path: '/claim',
      tags: ['links'],
      request: body(
        z
          .object({ token: z.string().max(200).optional(), code: z.string().max(40).optional() })
          .refine((v) => !!v.token !== !!v.code, 'give either token or code'),
      ),
      responses: {
        200: json(
          z.object({
            claim: z.string(),
            display_name: z.string(),
            require_approval: z.boolean(),
            approval_number: z.number().nullable(),
            expires_at: z.string(),
          }),
        ),
      },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      await authLimit(c, 'link');
      await limitOrThrow(ctx, 'link:global', GLOBAL_CLAIM_LIMIT, 600);
      const { token, code } = c.req.valid('json');
      const now = iso(ctx.clock.now());
      let link: LinkRow | null = null;
      if (token) {
        link = await ctx.db.first<LinkRow>(
          `SELECT * FROM device_links WHERE token_hash = ? AND ${ACTIVE}`,
          await tokenHash(ctx.config.TOKEN_PEPPER, token),
          now,
        );
      } else {
        const typed = normalizeCrockford(code!);
        if (typed.length === CODE_LENGTH) {
          const candidate = await ctx.db.first<LinkRow>(
            `SELECT * FROM device_links WHERE code_prefix = ? AND ${ACTIVE}`,
            typed.slice(0, PREFIX_LENGTH),
            now,
          );
          if (candidate) {
            if ((await codeHash(ctx, typed)) === candidate.code_hash) link = candidate;
            else {
              // Count the miss against this link; too many → invalidated.
              await ctx.db.run(
                `UPDATE device_links SET failed_attempts = failed_attempts + 1,
                   revoked_at = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE revoked_at END
                 WHERE id = ?`,
                MAX_CODE_ATTEMPTS,
                now,
                candidate.id,
              );
            }
          }
        }
      }
      if (!link) throw notFound('link_not_found');
      const claim = randomToken(32);
      const number = 10 + randomInt(90);
      await ctx.db.run(
        `UPDATE device_links SET claim_hash = ?, approval_number = ?, approval_choices = ?,
           approved_at = NULL, claim_user_agent = ? WHERE id = ?`,
        await tokenHash(ctx.config.TOKEN_PEPPER, claim),
        number,
        JSON.stringify(approvalChoices(number)),
        (c.req.header('user-agent') ?? '').slice(0, 300),
        link.id,
      );
      const user = await ctx.db.first<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id = ?',
        link.user_id,
      );
      return c.json(
        {
          claim,
          display_name: user?.display_name ?? '',
          require_approval: link.require_approval === 1,
          approval_number: link.require_approval === 1 ? number : null,
          expires_at: link.expires_at,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/claim/status',
      tags: ['links'],
      request: body(z.object({ claim: z.string().max(200) })),
      responses: { 200: json(z.object({ approved: z.boolean() })) },
    }),
    async (c) => {
      const link = await linkForClaim(c.env.ctx, c.req.valid('json').claim);
      return c.json({ approved: link.require_approval === 0 || link.approved_at !== null }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/claim/options',
      tags: ['links'],
      request: body(z.object({ claim: z.string().max(200) })),
      responses: { 200: json(WebAuthnJSON) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const link = await linkForClaim(ctx, c.req.valid('json').claim);
      if (link.require_approval === 1 && !link.approved_at) {
        throw new HttpError(403, 'approval_pending', 'Waiting for approval on your other device');
      }
      await assertUserActive(ctx, link.user_id);
      const user = await ctx.db.first<{ webauthn_handle: string; display_name: string }>(
        'SELECT webauthn_handle, display_name FROM users WHERE id = ?',
        link.user_id,
      );
      const options = await registrationOptions(
        ctx,
        { handle: user!.webauthn_handle, name: user!.display_name },
        link.user_id,
      );
      await storeChallenge(ctx, options.challenge, 'link', link.user_id, { link_id: link.id });
      return c.json(options as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/claim/verify',
      tags: ['links'],
      request: body(
        z.object({
          claim: z.string().max(200),
          response: WebAuthnJSON,
          label: z.string().trim().min(1).max(100).default('Passkey'),
        }),
      ),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const { claim, response, label } = c.req.valid('json');
      const link = await linkForClaim(ctx, claim);
      const reg = await verifyRegistration(ctx, response, 'link', link.user_id);
      if (reg.challenge.data.link_id !== link.id) throw notFound('link_not_found');
      const now = iso(ctx.clock.now());
      const consumed = {
        sql: 'EXISTS (SELECT 1 FROM device_links WHERE id = ? AND consumed_at = ?)',
        params: [link.id, now],
      };
      const session = await sessionInsert(
        c,
        { userId: link.user_id, passkeyId: reg.credentialId, fresh: true },
        consumed,
      );
      await ctx.db.batch([
        {
          sql: `UPDATE device_links SET consumed_at = ? WHERE id = ? AND claim_hash = ? AND ${ACTIVE}
                  AND (require_approval = 0 OR approved_at IS NOT NULL)`,
          params: [now, link.id, link.claim_hash, now],
        },
        passkeyInsert(ctx, reg, link.user_id, label, consumed),
        session.stmt,
      ]);
      if (!(await ctx.db.first('SELECT 1 FROM passkeys WHERE id = ?', reg.credentialId))) {
        throw new HttpError(410, 'link_expired', 'This link has expired or was already used');
      }
      session.setCookie();
      await notifyPasskeyAdded(ctx, link.user_id, reg.credentialId, label);
      return c.json({ ok: true as const }, 200);
    },
  );
}

export const linksModule: Module = {
  name: 'links',
  routes,
  publicPaths: ['/claim', '/claim/status', '/claim/options', '/claim/verify'],
};
