# CLAUDE.md — conventions for Someday

Read `SPEC.md` first; it is the source of truth for behaviour. The sibling project `~/src/stoppeklokke` (github.com/olemd/stoppeklokke) set the conventions: when SPEC and stoppeklokke disagree on *how*, follow stoppeklokke; on *what*, follow SPEC.

## Commands (Bun is the package manager and script runner)

- `bun install` — never npm/yarn/pnpm. `bun.lock` is committed.
- `bun run test` — vitest inside the Workers runtime (D1). **Never `bun test`** (`bunfig.toml` points Bun's own runner at an empty dir).
- `bun run test:bun` — the same suite against the self-hosted platform (bun:sqlite), plus Bun-only tests in `test/bun/`. Both must pass.
- `bun run lint` (Biome + SPDX check), `bun run typecheck` (every tsconfig), `bun run i18n:check`, `bun run build`.
- `bun run e2e` / `bun run screenshots` — Playwright against a throwaway self-hosted server (`scripts/browser.ts`), virtual passkeys; set `CHROMIUM_PATH=/usr/bin/chromium` to skip Playwright's download. Regenerate screenshots after visible UI changes.
- `bun run bootstrap` — interactive Cloudflare + GitHub setup (operator use; touches real accounts, never run it from automation).
- Before committing: lint, typecheck, i18n:check, test, test:bun, build.

## Commits and releases

- Every commit message is a Conventional Commit (`feat(scope): …`, `fix: …`). release-please reads them: `feat` → minor, `fix` → patch; `docs`, `chore`, `test`, `ci`, `refactor`, `style` do not release. A user-visible change must be `feat` or `fix`, or it never ships.
- Production deploys **only for releases**: merging the release PR creates the release, and `release-please.yml` calls `deploy.yml` for it. Pushes to `main` are not deployed. Redeploy by hand with `gh workflow run deploy.yml -f ref=<tag>`.

## Layout and boundaries

- `src/core/` — pure logic (config, crypto, time zones, settings, suggester, nudge planner). No Hono, no platform APIs. Unit-testable.
- `src/modules/<name>/` — features, each a `Module` listed in `src/modules/index.ts`. Routes mount at `/api/<name>` unless `mountPath` is set. `src/modules/app.ts` builds the one Hono app both entry points use; `isServerPath()` decides which paths the server answers (keep `run_worker_first` in `wrangler.template.jsonc` and `RUN_WORKER_FIRST` in `test/test-env.ts` in sync).
- `src/platform/cloudflare/` — the **only** place for Cloudflare APIs (Worker entry, D1 adapter, D1 rate limiter).
- `src/platform/bun/` — the self-hosted platform (SQLite adapter, migration runner using wrangler's `d1_migrations` table, static files from the same `_headers`, in-memory rate limiter, 15-min cron timer, `*_FILE` secrets). SPEC §1.1 calls this `node`; the name follows stoppeklokke.
- `src/shared/` — i18n catalogs (`en.json` is the source of truth) and the translator.
- `src/web/` — Preact PWA; `src/web/sw/` is the service worker.
- `scripts/` — operator and build scripts (Bun APIs allowed here and in `src/platform/bun/`).

## Modules (src/modules)

health (+ /healthz), auth (passkeys, sessions, recovery, re-auth), links (device links), invites, notices, settings, push, admin, lists (+ members, list invites, /api/join), items (+ log, tags, history), suggest (+ snooze), sync, notify (nudges, window, shared, agent, quiet hours — cron), takeaway (export, import, account deletion), oauth (/.well-known, /oauth/*, /api/oauth), mcp (/mcp).

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
- `test/authz-sweep.test.ts` calls every OpenAPI route with a path parameter as another user. New routes are covered automatically; give `fill()` the right ID when you add a new resource prefix.
- The export JSON Schema (`docs/someday-export-v1.schema.json`) is generated by `bun scripts/export-schema.ts`; a test fails when it is stale.
- MCP: read the spec text in the protocol repository before changing `src/modules/mcp`. Revision 2026-07-28 is stateless (no sessions); keep the legacy `initialize` path stateless too.
