# CLAUDE.md — conventions for Someday

Read `SPEC.md` first; it is the source of truth for behaviour. The sibling project `~/src/stoppeklokke` (github.com/olemd/stoppeklokke) set the conventions: when SPEC and stoppeklokke disagree on *how*, follow stoppeklokke; on *what*, follow SPEC.

## Commands (Bun is the package manager and script runner)

- `bun install` — never npm/yarn/pnpm. `bun.lock` is committed.
- `bun run test` — vitest inside the Workers runtime (D1). **Never `bun test`** (`bunfig.toml` points Bun's own runner at an empty dir).
- `bun run test:bun` — the same suite against the self-hosted platform (bun:sqlite), plus Bun-only tests in `test/bun/`. Both must pass.
- `bun run lint` (Biome + SPDX check), `bun run typecheck` (every tsconfig), `bun run i18n:check`, `bun run build`.
- Before committing: lint, typecheck, i18n:check, test, test:bun, build.

## Layout and boundaries

- `src/core/` — pure logic (config, crypto, time zones, settings, suggester, nudge planner). No Hono, no platform APIs. Unit-testable.
- `src/modules/<name>/` — features, each a `Module` listed in `src/modules/index.ts`. Routes mount at `/api/<name>` unless `mountPath` is set. `src/modules/app.ts` builds the one Hono app both entry points use; `isServerPath()` decides which paths the server answers (keep `run_worker_first` in `wrangler.template.jsonc` and `RUN_WORKER_FIRST` in `test/test-env.ts` in sync).
- `src/platform/cloudflare/` — the **only** place for Cloudflare APIs (Worker entry, D1 adapter, D1 rate limiter).
- `src/platform/bun/` — the self-hosted platform (SQLite adapter, migration runner using wrangler's `d1_migrations` table, static files from the same `_headers`, in-memory rate limiter, 15-min cron timer, `*_FILE` secrets). SPEC §1.1 calls this `node`; the name follows stoppeklokke.
- `src/shared/` — i18n catalogs (`en.json` is the source of truth) and the translator.
- `src/web/` — Preact PWA; `src/web/sw/` is the service worker.
- `scripts/` — operator and build scripts (Bun APIs allowed here and in `src/platform/bun/`).

## Rules

- SPDX header `// SPDX-License-Identifier: AGPL-3.0-or-later` in every source file (JSON exempt).
- IDs are ULIDs (`src/core/ulid.ts`). Datetimes are stored as ISO 8601 UTC strings, dates as `YYYY-MM-DD`; `ctx.clock.now()` is epoch **milliseconds**.
- Raw SQL with `?` parameters via the `Db` port. Never interpolate values into SQL.
- Multi-statement writes that must be atomic use `db.batch()`. Races are closed with gated statements (`INSERT … SELECT … WHERE EXISTS/NOT EXISTS`), not read-then-write.
- Every write to lists, items, log entries or memberships appends to `changes` in the same batch (`changeStmt`).
- Every query is scoped by membership (`requireListRole`). Admins never read others' items.
- Secrets stored hashed: bearer tokens with `tokenHash` (HMAC with `TOKEN_PEPPER`), recovery codes with PBKDF2.
- Migrations are additive only — they run before deploy.
- User settings are key/value in `user_settings` with defaults in `src/core/settings.ts`; never a migration.
- All UI strings and server-rendered text (push) go through i18n.
- Errors: throw `HttpError` (`src/core/errors.ts`).
- Free-tier CPU budget (10 ms): anything scaling with data size must be set-based SQL or paginated. PBKDF2 iterations default to 2 000 for that reason (see config).

## Gotchas

- Keep `compatibility_date` ≤ what `@cloudflare/vitest-pool-workers` supports (`2026-08-15`, in both `wrangler.template.jsonc` and `vitest.config.ts`).
- Biome replaces ESLint + Prettier (TS 7 has no JS API for typescript-eslint).
- `src/shared/i18n/catalogs.generated.ts` and `wrangler.jsonc` are generated and never committed.
- Tests share one rate limiter per `TestClock` (one per process in production).
- Under Bun, vitest needs `deps.interopDefault: false` (zod's re-exported namespace).
