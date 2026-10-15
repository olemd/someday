// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OAuth clients (§8.1). A client_id that is an HTTPS URL is a Client ID
 * Metadata Document (draft-ietf-oauth-client-id-metadata-document): fetched,
 * validated (its `client_id` must equal the URL exactly) and cached 24 h.
 * Dynamically registered clients (RFC 7591) exist only with MCP_ALLOW_DCR.
 *
 * Fetching a URL the client chose is an SSRF risk: only https, no IP
 * literals in private/loopback ranges, no `localhost`, no redirects, a
 * short timeout and a size cap.
 */
import { z } from 'zod';
import { badRequest } from '../../core/errors';
import { iso } from '../../core/ports';
import type { Ctx } from '../types';

export const CIMD_TTL_MS = 24 * 3600_000;
const MAX_DOC_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

export interface OAuthClient {
  client_id: string;
  kind: 'cimd' | 'dcr';
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

/** http://localhost / 127.0.0.1 / [::1] (any port): allowed for native clients (RFC 8252). */
export function isLoopback(u: URL): boolean {
  return (
    u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
  );
}

/** Redirect URIs must be https or loopback http, without fragments (§8.1 security). */
export function validRedirectUri(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.hash) return false;
    // §8.1 security: redirect URIs MUST be localhost or https.
    return u.protocol === 'https:' || isLoopback(u);
  } catch {
    return false;
  }
}

/**
 * Exact match, except that loopback redirect URIs may use any port (RFC 8252
 * §7.3: native apps get an ephemeral port).
 */
export function redirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  if (client.redirect_uris.includes(redirectUri)) return true;
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return false;
  }
  if (!isLoopback(u)) return false;
  return client.redirect_uris.some((r) => {
    try {
      const reg = new URL(r);
      return (
        isLoopback(reg) &&
        reg.hostname === u.hostname &&
        reg.pathname === u.pathname &&
        reg.search === u.search
      );
    } catch {
      return false;
    }
  });
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Whether a client_id URL is acceptable to fetch at all. */
export function cimdUrlAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) return false;
  if (u.pathname === '/' || u.pathname === '') return false; // must contain a path
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host.startsWith('[')) return false; // IPv6 literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !PRIVATE_V4.some((re) => re.test(host));
  return host.includes('.');
}

const CimdSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(200),
  client_uri: z.url().optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
  token_endpoint_auth_method: z.string().optional(),
});

async function fetchCimd(ctx: Ctx, url: string): Promise<OAuthClient> {
  if (!cimdUrlAllowed(url))
    throw new OAuthError('invalid_client', 'client_id is not an acceptable https URL');
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      headers: { accept: 'application/json' },
      // Workers reject `redirect: 'error'`; with 'manual' a redirect comes
      // back as a 3xx response, which is refused below like any non-2xx.
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    ctx.log.warn('client metadata fetch failed', { client_id: url, err: String(err) });
    throw new OAuthError('invalid_client', 'Could not fetch the client metadata document');
  }
  if (res.status >= 300 && res.status < 400)
    throw new OAuthError('invalid_client', 'Client metadata document redirects; use its final URL');
  if (!res.ok)
    throw new OAuthError('invalid_client', `Client metadata document returned ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DOC_BYTES)
    throw new OAuthError('invalid_client', 'Client metadata document too large');
  let doc: z.infer<typeof CimdSchema>;
  try {
    doc = CimdSchema.parse(JSON.parse(text));
  } catch {
    throw new OAuthError('invalid_client', 'Client metadata document is not valid');
  }
  if (doc.client_id !== url) {
    throw new OAuthError(
      'invalid_client',
      'client_id in the metadata document does not match its URL',
    );
  }
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') {
    throw new OAuthError(
      'invalid_client',
      'Only public clients (token_endpoint_auth_method "none") are supported',
    );
  }
  if (!doc.redirect_uris.every(validRedirectUri)) {
    throw new OAuthError('invalid_client', 'redirect_uris must use https or loopback http');
  }
  return {
    client_id: url,
    kind: 'cimd',
    client_name: doc.client_name,
    client_uri: doc.client_uri ?? null,
    redirect_uris: doc.redirect_uris,
  };
}

interface ClientRow {
  client_id: string;
  kind: 'cimd' | 'dcr';
  client_name: string;
  client_uri: string | null;
  redirect_uris: string;
  fetched_at: string;
}

const fromRow = (r: ClientRow): OAuthClient => ({
  client_id: r.client_id,
  kind: r.kind,
  client_name: r.client_name,
  client_uri: r.client_uri,
  redirect_uris: JSON.parse(r.redirect_uris) as string[],
});

/** Resolve a client_id: cached CIMD (refreshed after 24 h), or a registered DCR client. */
export async function resolveClient(ctx: Ctx, clientId: string): Promise<OAuthClient> {
  const row = await ctx.db.first<ClientRow>(
    'SELECT * FROM oauth_clients WHERE client_id = ?',
    clientId,
  );
  if (row?.kind === 'dcr') {
    if (!ctx.config.MCP_ALLOW_DCR) throw new OAuthError('invalid_client', 'Unknown client');
    return fromRow(row);
  }
  if (row && ctx.clock.now() - Date.parse(row.fetched_at) < CIMD_TTL_MS) return fromRow(row);
  if (!clientId.startsWith('https://')) throw new OAuthError('invalid_client', 'Unknown client');
  const client = await fetchCimd(ctx, clientId);
  const now = iso(ctx.clock.now());
  await ctx.db.run(
    `INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, fetched_at, created_at)
     VALUES (?, 'cimd', ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name, client_uri = excluded.client_uri,
       redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`,
    clientId,
    client.client_name,
    client.client_uri,
    JSON.stringify(client.redirect_uris),
    now,
    now,
  );
  return client;
}

export const DcrSchema = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
  client_name: z.string().trim().min(1).max(200).optional(),
  client_uri: z.url().optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  application_type: z.string().optional(),
});

export function checkDcr(input: z.infer<typeof DcrSchema>) {
  if (!input.redirect_uris.every(validRedirectUri)) {
    throw badRequest('invalid_redirect_uri', 'redirect_uris must use https or loopback http');
  }
  if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') {
    throw badRequest('invalid_client_metadata', 'Only public clients are supported');
  }
}
