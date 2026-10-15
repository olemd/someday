// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tokens (§8.1): opaque, stored hashed. Access tokens live 1 h; refresh
 * tokens 30 days and rotate on every use. Presenting an already-rotated
 * refresh token means it leaked: the whole family is revoked.
 */
import { randomToken, timingSafeEqual, toBase64Url, tokenHash } from '../../core/crypto';
import { iso } from '../../core/ports';
import { ulid } from '../../core/ulid';
import type { AuthInfo, Ctx, Scope } from '../types';
import { OAuthError } from './clients';

export const ACCESS_TTL_MS = 3600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const CODE_TTL_MS = 10 * 60_000;
export const SCOPES: Scope[] = ['someday:read', 'someday:write', 'someday:notify'];

export const mcpResource = (ctx: Ctx) => `${ctx.config.PUBLIC_ORIGIN}/mcp`;

export function parseScopes(raw: string | undefined | null): Scope[] {
  const asked = (raw ?? '').split(/\s+/).filter(Boolean);
  return SCOPES.filter((s) => asked.includes(s));
}

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(verifier)) == challenge. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  return timingSafeEqual(toBase64Url(digest), challenge);
}

/** Resource indicators (RFC 8707): our MCP endpoint, with or without a trailing slash. */
export function resourceMatches(ctx: Ctx, resource: string | undefined | null): boolean {
  if (!resource) return true; // tolerate clients that omit it; tokens are still bound to /mcp
  const r = resource.replace(/\/+$/, '');
  return (
    r.toLowerCase() === mcpResource(ctx).toLowerCase() ||
    r.toLowerCase() === ctx.config.PUBLIC_ORIGIN.toLowerCase()
  );
}

export async function issueTokens(
  ctx: Ctx,
  grantId: string,
  familyId: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const access = `sda_${randomToken(32)}`;
  const refresh = `sdr_${randomToken(32)}`;
  const now = ctx.clock.now();
  const pepper = ctx.config.TOKEN_PEPPER;
  await ctx.db.batch([
    {
      sql: "INSERT INTO oauth_tokens (token_hash, grant_id, family_id, kind, expires_at) VALUES (?, ?, ?, 'access', ?)",
      params: [await tokenHash(pepper, access), grantId, familyId, iso(now + ACCESS_TTL_MS)],
    },
    {
      sql: "INSERT INTO oauth_tokens (token_hash, grant_id, family_id, kind, expires_at) VALUES (?, ?, ?, 'refresh', ?)",
      params: [await tokenHash(pepper, refresh), grantId, familyId, iso(now + REFRESH_TTL_MS)],
    },
  ]);
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000 };
}

interface CodeRow {
  grant_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: string;
  used_at: string | null;
  client_id: string;
  scopes: string;
}

export async function createCode(
  ctx: Ctx,
  grantId: string,
  redirectUri: string,
  codeChallenge: string,
): Promise<string> {
  const code = randomToken(32);
  await ctx.db.run(
    'INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
    await tokenHash(ctx.config.TOKEN_PEPPER, code),
    grantId,
    redirectUri,
    codeChallenge,
    iso(ctx.clock.now() + CODE_TTL_MS),
  );
  return code;
}

/** grant_type=authorization_code: single-use code, matching client/redirect, PKCE. */
export async function exchangeCode(
  ctx: Ctx,
  p: { code: string; client_id: string; redirect_uri: string; code_verifier: string },
) {
  const hash = await tokenHash(ctx.config.TOKEN_PEPPER, p.code);
  const row = await ctx.db.first<CodeRow>(
    `SELECT c.grant_id, c.redirect_uri, c.code_challenge, c.expires_at, c.used_at, g.client_id, g.scopes
       FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = ?`,
    hash,
  );
  if (!row) throw new OAuthError('invalid_grant', 'Unknown authorization code');
  if (row.used_at) {
    // A replayed code: revoke what the first exchange issued (OAuth 2.1 §4.1.3).
    await revokeGrantTokens(ctx, row.grant_id);
    throw new OAuthError('invalid_grant', 'Authorization code already used');
  }
  if (Date.parse(row.expires_at) <= ctx.clock.now())
    throw new OAuthError('invalid_grant', 'Authorization code expired');
  if (row.client_id !== p.client_id)
    throw new OAuthError('invalid_grant', 'Code was issued to another client');
  if (row.redirect_uri !== p.redirect_uri)
    throw new OAuthError('invalid_grant', 'redirect_uri does not match');
  if (!(await pkceMatches(p.code_verifier, row.code_challenge))) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed');
  }
  const r = await ctx.db.run(
    'UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
    iso(ctx.clock.now()),
    hash,
  );
  if (r.changes !== 1) throw new OAuthError('invalid_grant', 'Authorization code already used');
  const tokens = await issueTokens(ctx, row.grant_id, ulid(ctx.clock.now()));
  return { ...tokens, scope: row.scopes };
}

/** grant_type=refresh_token with rotation and reuse detection. */
export async function refresh(ctx: Ctx, p: { refresh_token: string; client_id: string }) {
  const hash = await tokenHash(ctx.config.TOKEN_PEPPER, p.refresh_token);
  const row = await ctx.db.first<{
    grant_id: string;
    family_id: string;
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
    client_id: string;
    scopes: string;
  }>(
    `SELECT t.grant_id, t.family_id, t.expires_at, t.used_at, t.revoked_at, g.client_id, g.scopes
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ? AND t.kind = 'refresh'`,
    hash,
  );
  if (!row || row.revoked_at) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  if (row.client_id !== p.client_id)
    throw new OAuthError('invalid_grant', 'Token was issued to another client');
  if (row.used_at) {
    // Reuse of a rotated token: someone else has it. Revoke the family.
    await ctx.db.run(
      'UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
      iso(ctx.clock.now()),
      row.family_id,
    );
    ctx.log.warn('refresh token reuse; family revoked', { client: row.client_id });
    throw new OAuthError('invalid_grant', 'Refresh token already used');
  }
  if (Date.parse(row.expires_at) <= ctx.clock.now())
    throw new OAuthError('invalid_grant', 'Refresh token expired');
  const r = await ctx.db.run(
    'UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
    iso(ctx.clock.now()),
    hash,
  );
  if (r.changes !== 1) throw new OAuthError('invalid_grant', 'Refresh token already used');
  const tokens = await issueTokens(ctx, row.grant_id, row.family_id);
  return { ...tokens, scope: row.scopes };
}

export async function revokeGrantTokens(ctx: Ctx, grantId: string) {
  await ctx.db.run(
    'UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL',
    iso(ctx.clock.now()),
    grantId,
  );
}

/** RFC 7009: revoke a token (and, for a refresh token, its family). Unknown tokens are fine. */
export async function revokeToken(ctx: Ctx, token: string) {
  const hash = await tokenHash(ctx.config.TOKEN_PEPPER, token);
  const row = await ctx.db.first<{ family_id: string; kind: string }>(
    'SELECT family_id, kind FROM oauth_tokens WHERE token_hash = ?',
    hash,
  );
  if (!row) return;
  await ctx.db.run(
    row.kind === 'refresh'
      ? 'UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL'
      : 'UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    iso(ctx.clock.now()),
    row.kind === 'refresh' ? row.family_id : hash,
  );
}

/** Validate a bearer token for /mcp; null if invalid, expired, revoked or the user is inactive. */
export async function verifyAccessToken(
  ctx: Ctx,
  token: string,
): Promise<Extract<AuthInfo, { kind: 'oauth' }> | null> {
  if (!token.startsWith('sda_')) return null;
  const row = await ctx.db.first<{
    grant_id: string;
    expires_at: string;
    user_id: string;
    role: 'admin' | 'user';
    client_id: string;
    client_name: string;
    scopes: string;
    list_ids: string | null;
    resource: string;
    last_used_at: string | null;
  }>(
    `SELECT t.grant_id, t.expires_at, g.user_id, u.role, g.client_id, c.client_name, g.scopes, g.list_ids,
            g.resource, g.last_used_at
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN oauth_clients c ON c.client_id = g.client_id
       JOIN users u ON u.id = g.user_id
      WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL
        AND u.disabled_at IS NULL AND u.deleted_at IS NULL`,
    await tokenHash(ctx.config.TOKEN_PEPPER, token),
  );
  if (!row || Date.parse(row.expires_at) <= ctx.clock.now()) return null;
  // Audience: tokens are only ever issued for this server's /mcp (RFC 8707).
  if (row.resource !== mcpResource(ctx)) return null;
  // "Last used" for the settings page, at most once a minute.
  const now = ctx.clock.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60_000) {
    ctx.scheduler.waitUntil(
      ctx.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', iso(now), row.grant_id),
    );
  }
  return {
    kind: 'oauth',
    userId: row.user_id,
    role: row.role,
    tokenId: row.grant_id,
    clientId: row.client_id,
    clientName: row.client_name,
    scopes: parseScopes(row.scopes),
    listIds: row.list_ids ? (JSON.parse(row.list_ids) as string[]) : null,
  };
}

/** Cron: drop expired and long-revoked tokens and stale codes. */
export async function purgeTokens(ctx: Ctx) {
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    { sql: 'DELETE FROM oauth_tokens WHERE expires_at < ?', params: [now] },
    { sql: 'DELETE FROM oauth_codes WHERE expires_at < ?', params: [now] },
  ]);
}
