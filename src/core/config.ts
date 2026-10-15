// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime configuration (§9): every default lives here and can be overridden
 * by a wrangler var / environment variable of the same name. Secrets
 * (VAPID_*, BOOTSTRAP_ADMIN_TOKEN, TOKEN_PEPPER) come from the same place.
 *
 * Invalid or missing values never crash the app: they are collected into
 * `errors` and surfaced by GET /api/health, so a fork with a typo gets a
 * readable message instead of a cryptic 500.
 */
import { z } from 'zod';

export const DEFAULT_SOURCE_URL = 'https://github.com/olemd/someday';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const ConfigSchema = z.object({
  /** Required on both targets: WebAuthn RP ID/origin, OAuth issuer, push deep links (§10a). */
  PUBLIC_ORIGIN: z
    .url()
    .refine(
      (u) => new URL(u).origin === u,
      'must be a bare origin like https://example.com (no path or trailing slash)',
    ),
  RP_NAME: z.string().min(1).default('Someday'),
  SOURCE_URL: z.url().default(DEFAULT_SOURCE_URL),
  APP_VERSION: z.string().default('0.0.0-dev'),
  GIT_SHA: z.string().default('unknown'),

  // ── Secrets ───────────────────────────────────────────────────────────
  /** Pepper for every stored token hash. Changing it logs everyone out. */
  TOKEN_PEPPER: z.string().min(32, 'must be at least 32 characters'),
  BOOTSTRAP_ADMIN_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  /** Contact for push services; defaults to PUBLIC_ORIGIN. */
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:)/, 'must start with mailto: or https:')
    .optional(),

  // ── Registration and auth (§2) ────────────────────────────────────────
  REGISTRATION_MODE: z.enum(['invite', 'open', 'closed']).default('invite'),
  INVITES_ADMIN_ONLY: bool.default(false),
  INVITE_TTL_DAYS: int(1, 365).default(7),
  OPEN_REGISTRATIONS_PER_HOUR: int(1, 1000).default(5),
  DEVICE_LINK_TTL_MIN: int(1, 1440).default(15),
  SESSION_TTL_DAYS: int(1, 3650).default(90),
  /**
   * PBKDF2 iterations for recovery codes (§2.1). SPEC asks for ≥100k, but
   * signup hashes 10 codes in one request: 100k × 10 ≈ 86 ms CPU, far over
   * the Workers free tier's 10 ms. Each code carries an 80-bit random secret,
   * so offline guessing is infeasible regardless; 2 000 keeps signup at
   * ~2–3 ms. Raise it on a paid plan (Workers cap it at 100 000).
   */
  RECOVERY_PBKDF2_ITERATIONS: int(1000, 100_000).default(2_000),
  /** Auth attempts per IP per 10 minutes (login, recovery, setup, link codes). */
  AUTH_RATE_LIMIT: int(1, 10_000).default(30),

  // ── Lists and items (§3) ──────────────────────────────────────────────
  ANON_COUNT_MIN_MEMBERS: int(3, 1000).default(4),
  LIST_INVITE_TTL_DAYS: int(1, 365).default(7),
  DELETE_GRACE_DAYS: int(0, 365).default(30),

  // ── Suggester and notifications (§4, §5) ──────────────────────────────
  SUGGESTER: z.enum(['weighted', 'llm']).default('weighted'),
  SNOOZE_DAYS: int(1, 365).default(7),
  SHARED_PUSH_INTERVAL_MIN: int(1, 1440).default(30),
  AGENT_NOTIFY_DAILY_MAX: int(0, 1000).default(10),

  // ── MCP / OAuth (§8) ──────────────────────────────────────────────────
  MCP_ALLOW_DCR: bool.default(false),
  MCP_RATE_LIMIT_PER_MIN: int(1, 10_000).default(120),
});

export type AppConfig = z.output<typeof ConfigSchema> & {
  /** WebAuthn RP ID: the host name of PUBLIC_ORIGIN. */
  RP_ID: string;
};

export interface ParsedConfig {
  config: AppConfig;
  errors: string[];
}

/** Placeholders used when a required value is invalid, so /api/health can still answer. */
const FALLBACK = {
  PUBLIC_ORIGIN: 'http://invalid.invalid',
  TOKEN_PEPPER: 'invalid-pepper-invalid-pepper-invalid-pepper',
};

/**
 * Secrets may also be given as `<NAME>_FILE` pointing at a file (Podman
 * secrets, §10a). The platform resolves those before calling parseConfig.
 */
export function parseConfig(raw: Record<string, unknown>): ParsedConfig {
  // Treat empty strings as unset: CI renders unset GitHub Variables as "".
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => typeof v === 'string' && v !== ''),
  );
  const res = ConfigSchema.safeParse(cleaned);
  let errors: string[] = [];
  let parsed: z.output<typeof ConfigSchema>;
  if (res.success) {
    parsed = res.data;
  } else {
    errors = res.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    // Re-parse with only the valid keys plus fallbacks, so defaults still apply.
    const bad = new Set(res.error.issues.map((i) => String(i.path[0])));
    const partial = Object.fromEntries(Object.entries(cleaned).filter(([k]) => !bad.has(k)));
    parsed = ConfigSchema.parse({ ...FALLBACK, ...partial });
  }
  if (parsed.SUGGESTER === 'llm') {
    errors.push('SUGGESTER=llm is not available in v1; the weighted suggester is used');
  }
  const vapid = [parsed.VAPID_PUBLIC_KEY, parsed.VAPID_PRIVATE_KEY].filter(Boolean).length;
  if (vapid === 1) errors.push('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together');
  const url = new URL(parsed.PUBLIC_ORIGIN);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && !errors.length) {
    errors.push('PUBLIC_ORIGIN must use https (passkeys require it outside localhost)');
  }
  return { config: { ...parsed, RP_ID: url.hostname }, errors };
}
