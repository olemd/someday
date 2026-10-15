// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Renders wrangler.jsonc from wrangler.template.jsonc.
 *
 * Values come from the environment: GitHub Variables in CI, and locally from
 * .env (Bun loads it automatically) or .dev.vars. No account-specific IDs or
 * domains live in the repo, so a fork deploys without code changes.
 *
 * CUSTOM_DOMAIN (optional) adds a Workers custom-domain route; the zone must be
 * on Cloudflare. Without it the Worker is served on *.workers.dev.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** Parse KEY=VALUE lines from .dev.vars (wrangler's local secrets file). */
function loadDevVars(): Record<string, string> {
  const file = join(root, '.dev.vars');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function gitSha(): string {
  const r = Bun.spawnSync(['git', 'describe', '--always', '--dirty', '--abbrev=40'], { cwd: root });
  return r.success ? r.stdout.toString().trim() : 'unknown';
}

const pkg = (await Bun.file(join(root, 'package.json')).json()) as { version: string };
const env: Record<string, string | undefined> = { ...loadDevVars(), ...process.env };
const val = (k: string, fallback: string) => (env[k] && env[k] !== '' ? env[k]! : fallback);

const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const values: Record<string, string> = {
  WORKER_NAME: val('WORKER_NAME', 'someday'),
  // The all-zero ID only works for local development (wrangler dev / tests).
  D1_DATABASE_ID: val('D1_DATABASE_ID', ZERO_ID),
  D1_PREVIEW_DATABASE_ID: val('D1_PREVIEW_DATABASE_ID', ZERO_ID),
  PUBLIC_ORIGIN: val('PUBLIC_ORIGIN', 'http://localhost:8787'),
  PREVIEW_ORIGIN: val('PREVIEW_ORIGIN', 'http://localhost:8787'),
  SOURCE_URL: val('SOURCE_URL', 'https://github.com/olemd/someday'),
  APP_VERSION: val('APP_VERSION', pkg.version),
  GIT_SHA: val('GIT_SHA', gitSha()),
};

// Substitute placeholders in the raw text (JSON-escaped), then parse as JSONC
// (comments and trailing commas allowed).
const rendered = readFileSync(join(root, 'wrangler.template.jsonc'), 'utf8').replace(
  /\$\{([A-Z0-9_]+)\}/g,
  (_, k: string) => {
    if (!(k in values)) throw new Error(`Unknown placeholder \${${k}} in wrangler.template.jsonc`);
    return JSON.stringify(values[k]).slice(1, -1);
  },
);
const config = Bun.JSONC.parse(rendered) as Record<string, unknown>;
const domain = env.CUSTOM_DOMAIN;
if (domain) config.routes = [{ pattern: domain, custom_domain: true }];

const header =
  '// GENERATED from wrangler.template.jsonc by scripts/render-wrangler-config.ts. Do not edit or commit.\n';
await Bun.write(join(root, 'wrangler.jsonc'), `${header + JSON.stringify(config, null, 2)}\n`);
// Values from the environment are deliberately not echoed: CI logs are
// visible to anyone who can read the repository.
console.log('wrangler.jsonc rendered from wrangler.template.jsonc');
