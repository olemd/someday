// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-hosting settings that are not part of the app config (src/core/config.ts):
 * where things live and how the server listens. Read from the environment
 * (Bun loads `.env` automatically).
 */

export interface ServerEnv {
  port: number;
  host: string;
  databasePath: string;
  staticDir: string;
  migrationsDir: string;
  /**
   * Reverse proxies whose X-Forwarded-For may be believed (IPs or CIDRs).
   * Empty = use the socket address. See clientIpFrom.
   */
  trustedProxies: Cidr[];
}

export function readServerEnv(env: Record<string, string | undefined>): ServerEnv {
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '127.0.0.1',
    databasePath: env.DATABASE_PATH ?? './data/someday.db',
    staticDir: env.STATIC_DIR ?? './dist/web',
    migrationsDir: env.MIGRATIONS_DIR ?? './migrations',
    trustedProxies: parseCidrs(env.TRUSTED_PROXIES ?? ''),
  };
}

/**
 * Secrets may be given as `<NAME>_FILE` (Podman secrets mount files under
 * /run/secrets, §10a). The file's content (trimmed) becomes `<NAME>`; an
 * explicit `<NAME>` wins.
 */
export function resolveFileSecrets(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (!k.endsWith('_FILE') || !v) continue;
    const name = k.slice(0, -'_FILE'.length);
    if (!out[name]) out[name] = read(v).trim();
  }
  return out;
}

// ── IP addresses and CIDR ranges (IPv4 and IPv6) ─────────────────────────

export interface Cidr {
  v6: boolean;
  bits: bigint;
  prefix: number;
}

/** "::ffff:1.2.3.4" (IPv4-mapped IPv6, as Bun reports IPv4 clients on dual-stack sockets) → "1.2.3.4". */
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

/** Parse an IP to a 32- or 128-bit integer, or null if it is not an IP. */
export function parseIp(input: string): { v6: boolean; bits: bigint } | null {
  const ip = unmap(input.trim());
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { v6: false, bits: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  if (!ip.includes(':') || !/^[0-9a-f:]+$/i.test(ip)) return null;
  const [head, tail, ...rest] = ip.split('::');
  if (rest.length) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? h.length !== 8 : missing < 1) return null;
  const groups = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...t];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return {
    v6: true,
    bits: groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n),
  };
}

/** "10.0.0.0/8, 127.0.0.1, ::1" → ranges. Invalid entries throw: a typo must not silently disable trust rules. */
export function parseCidrs(list: string): Cidr[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [addr, len] = entry.split('/');
      const ip = parseIp(addr!);
      const max = ip?.v6 ? 128 : 32;
      const prefix = len === undefined ? max : Number(len);
      if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
        throw new Error(`TRUSTED_PROXIES: invalid entry "${entry}"`);
      }
      return { v6: ip.v6, bits: ip.bits, prefix };
    });
}

export function inCidrs(ip: string, ranges: Cidr[]): boolean {
  const p = parseIp(ip);
  if (!p) return false;
  return ranges.some((r) => {
    if (r.v6 !== p.v6) return false;
    const width = p.v6 ? 128n : 32n;
    const shift = width - BigInt(r.prefix);
    return p.bits >> shift === r.bits >> shift;
  });
}

/**
 * The client IP for the auth rate limit.
 *
 * Without trusted proxies: the socket address. With them, X-Forwarded-For is
 * only believed when the request really comes from a trusted proxy; the list
 * is read right to left, skipping trusted hops, and the first untrusted
 * address is the client. A client talking to the server directly, or
 * prepending fake entries, cannot choose its own address — so it can neither
 * dodge the rate limit nor make everyone share the proxy's address.
 */
export function clientIpFrom(req: Request, socketIp: string | undefined, trusted: Cidr[]): string {
  const socket = socketIp ? unmap(socketIp) : 'unknown';
  if (!trusted.length || !inCidrs(socket, trusted)) return socket;
  const hops = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => unmap(s.trim()))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!inCidrs(hops[i]!, trusted)) return parseIp(hops[i]!) ? hops[i]! : socket;
  }
  return hops[0] ?? socket;
}
