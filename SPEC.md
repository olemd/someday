# Someday — Specification v0.1

> "Things I want to do or find out about *some day*." Not a todo list: a slow-moving collection of ideas, experiences and curiosities, with a "give me something to do" button.

- **Domain:** `someday.silly.work`
- **Repo:** `github.com/olemd/someday` (AGPL-3.0, footer link to repo)
- **Sibling project:** `olemd/stoppeklokke` — reuse its conventions (layout, tooling, CI, i18n, PWA/push code) wherever possible. When this spec and stoppeklokke disagree on *how*, follow stoppeklokke; when they disagree on *what*, follow this spec.
- **UI languages:** English + Norwegian (bokmål), structured for more. 24h clock everywhere, ISO 8601 dates in exports/API.
- **Principle:** sensible defaults everywhere, every default overridable (env var, per-user setting, or per-list setting).

---

## 1. Stack

| Concern | Choice |
|---|---|
| Runtime | Cloudflare Workers (TypeScript), free tier as design target |
| HTTP | Hono |
| DB | D1 (SQLite), migrations in `migrations/` via wrangler |
| Static/PWA | Workers Static Assets |
| Frontend | Same as stoppeklokke (if none established: Preact + Vite) |
| Tooling | Bun for install/scripts/tests where it doesn't fight wrangler; vitest + `@cloudflare/vitest-pool-workers` for Worker tests |
| Passkeys | `@simplewebauthn/server` / `@simplewebauthn/browser` |
| Web Push | VAPID + RFC 8291 encryption via WebCrypto (reuse stoppeklokke's implementation) |
| Zip (export) | `fflate` |
| Scheduling | Cron Trigger every 15 min |
| Rate limiting | Workers Rate Limiting binding |

IDs: ULIDs, client-generatable (needed for offline creates).

### 1.1 Two deploy targets, one codebase
Cloudflare Workers is the primary target (and the only one with a deploy pipeline). Self-hosting in a Podman container must also work (§10a). To keep that cheap:

- **All platform-specific code lives in `src/platform/{cloudflare,node}/`** (`node` = Bun runtime). Core code never touches `env.DB`, cron, rate-limit bindings or asset serving directly.
- Platform interface:
  ```ts
  interface Platform {
    db: Db;               // D1-shaped: prepare().bind().all/first/run, batch()
    rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
    config: Config;       // vars + secrets, already validated
    now(): Date;
  }
  ```
- `Db` mirrors the D1 API subset we use; the Bun adapter wraps `bun:sqlite`. Same SQL, same migration files. No ORM required.
- Scheduled work is a plain `runScheduled(platform, now)` function: called from the Workers `scheduled` handler on CF, from an in-process 15-min timer in the container.
- Hono app is constructed once in `src/app.ts` and mounted by each entrypoint (`src/entry/worker.ts`, `src/entry/server.ts`).

---

## 2. Users, auth, registration

### 2.1 Passkeys
- WebAuthn only. No passwords, no email required.
- Multiple passkeys per user; manage (name, last used, delete) in settings. Cannot delete the last one.
- **Add a device via one-time link.** Platform passkeys don't sync across ecosystems (Apple ↔ Android ↔ Linux browsers), and not everyone has a password manager. So a logged-in user can create a *device link*:
  - Settings → "Add another device" shows a link, a QR code, and a short code (8 chars, Crockford base32, grouped `XXXX-XXXX`) for typing on `/link` when copying a URL is awkward.
  - Single use, default TTL 15 min (`DEVICE_LINK_TTL_MIN`), stored hashed, at most 3 active per user. Creating requires a fresh passkey assertion (≤5 min), so a hijacked session alone can't mint one.
  - Opening it on the new device starts a WebAuthn **registration** ceremony bound to the existing user. Only after the new passkey is registered is the link consumed and a session issued. Abandoned ceremony → link still valid until TTL.
  - Optional per-user setting "Require approval from an existing device" (default off): the new device shows a 2-digit number, the originating device must pick it to approve (protects against a leaked link in chat history/email).
  - On success: push + in-app notice to all other sessions ("New passkey added: Firefox on Linux, 09:22"), with a one-tap "That wasn't me" that revokes the passkey and its sessions.
  - Rate limit `/link` code attempts per IP and globally; codes are invalidated after 5 failed attempts against the same user.
  - The browser's native cross-device flow (WebAuthn hybrid/QR via phone) is also allowed and needs no extra work, but is not relied on.
- **Recovery:** 10 one-time recovery codes generated at signup, shown once, stored hashed (argon2/scrypt not available → use PBKDF2-SHA256 via WebCrypto, ≥100k iterations). Regenerate from settings.
- Sessions: opaque token, hashed in D1, HttpOnly + Secure + SameSite=Lax cookie. Default 90 days sliding. List/revoke sessions in settings.

### 2.2 Registration
- `REGISTRATION_MODE` = `invite` (default) | `open` | `closed`.
- Invite links: created by any user (default) or admins only (`INVITES_ADMIN_ONLY=false`). Default expiry 7 days, single use.
- Bootstrap: first admin is created with `BOOTSTRAP_ADMIN_TOKEN` secret (`/setup?token=…`). Endpoint disabled once an admin exists.
- `open` mode: rate limit registration per IP (default 5/hour).

### 2.3 Roles
- Instance: `admin` | `user`. Admin can: list users, disable users, change registration mode at runtime (overrides env), view basic stats. Admin **cannot** read other users' private items.

---

## 3. Data model

### 3.1 Lists
- Every user gets a default private list "Someday" on signup.
- A user can create more lists (e.g. "Things to do with Kari", "Learn about").
- `list_members(list_id, user_id, role)` with role `owner` | `editor` | `viewer`. Exactly one owner; ownership transferable.
- Sharing via list invite link (role chosen at creation, default `editor`, expiry 7 days, max uses default 1). Members can leave; owner can remove.
- Deleting a list: owner only, soft-delete 30 days then purge.

### 3.2 Item
| Field | Type | Notes |
|---|---|---|
| `id` | ULID | |
| `list_id` | ULID | movable between lists the user can edit |
| `title` | text | required, ≤200 chars |
| `notes` | markdown | optional |
| `status` | enum | `idea` → `planned` → `done`, plus `archived` (dropped) |
| `repeatable` | bool | default false. Repeatable items stay `idea`/`planned` after a log entry |
| `duration` | enum? | `short` (<1h), `half_day`, `day`, `weekend`, `trip` |
| `setting` | enum? | `indoor`, `outdoor`, `either` |
| `cost` | int? | 0 = free … 3 = expensive |
| `energy` | enum? | `low`, `medium`, `high` |
| `social` | enum? | `solo`, `together`, `either` |
| `valid_from` / `valid_to` | date? | absolute window ("before 2030") |
| `months` | int bitmask? | seasonal window, e.g. Sep–Mar for aurora; wraps year |
| `links` | json array | `[{url, label?}]` |
| `location` | json? | `{label, lat?, lon?}` — stored only in v1; no geo filtering yet |
| `tags` | via `item_tags` | free-form, per user namespace, lowercased |
| `snoozed_until` | datetime? | set by "not now" |
| `last_suggested_at` | datetime? | per item (shared lists: per user in `suggestion_state`) |
| `created_by`, `created_at`, `updated_at` | | |
| `field_clock` | json | per-field last-modified timestamps for LWW sync (§6) |

All context fields are optional. Unset = matches any filter.

### 3.3 Log entries (`item_log`)
- Created when an item is done (or done again, if repeatable): `{id, item_id, user_id, done_on (date), note?, rating? (1–5), visibility}`.
- `visibility` = `private` | `anonymous` | `shared`:
  - `private`: only the author ever sees it (UI, sync, export, MCP). Not counted anywhere; other members get no hint it exists.
  - `anonymous`: the entry itself is visible only to the author, but contributes to the anonymous done-count below.
  - `shared`: visible to all members of the list, attributed to the author.
  - On private (single-member) lists the field is irrelevant; stored as `private`.
  - Default in the "Done" dialog on a shared list: `private` (safe default), remembered per user per list. Visibility can be changed afterwards by the author.
- **"Done" is per user, not per item, on shared lists.** Logging never changes the item's `status` for other members. An item counts as *done for me* if I have a log entry; non-repeatable items done-for-me drop out of *my* suggestions and *my* open view, but stay open for others. The item-level `done` status is only set automatically on single-member lists. On shared lists an editor can still explicitly mark the item done/archived for everyone (separate action, confirms first).
- Undo removes the entry (and restores previous status where it was changed).
- **Done-count:** on shared lists each item shows "done by N members" = distinct users with an `anonymous` or `shared` entry. Shared entries are additionally listed by name. Computed server-side and delivered as an aggregate — anonymous and private entries never leave the server for other users.
  - Small-group leak: in a 2-person list, N reveals the other person. Therefore the count is only shown when the list has ≥ `ANON_COUNT_MIN_MEMBERS` members (default 4, per-list override by owner, minimum 3). Below that, only shared entries are shown, and the Done dialog greys out `anonymous` with a short explanation ("too few members to stay anonymous").
  - Changes caused by anonymous entries never trigger notifications or appear in activity feeds (timing would de-anonymise).
- **No photos in v1** (see §11). Schema should leave room for `attachments` later.

### 3.4 Change tracking
- `changes(seq INTEGER PK AUTOINCREMENT, entity, entity_id, list_id, op, at)` — appended on every write; drives sync and shared-list notifications. Deletes are tombstones here.

---

## 4. "Give me something" (suggester)

Behind an interface so an LLM implementation can be added later without touching callers:

```ts
interface Suggester {
  suggest(ctx: SuggestContext): Promise<Suggestion | null>;
}
type Suggestion = { item: Item; score: number; reasons: string[] };
```

### 4.1 v1: filtered weighted random (`WeightedSuggester`)
**Input filters** (all optional, UI presents them as quick chips): available time (max `duration`), `setting`, max `cost`, `energy`, `social`, lists to include (default: all lists the user is a member of, including shared; each membership has an "include in suggestions" toggle, default on), tags include/exclude.

**Eligibility:**
1. Status `idea` or `planned`; `archived` excluded; non-repeatable items *done for this user* (§3.3) excluded.
2. Not snoozed.
3. Today (user TZ) inside `valid_from..valid_to` and inside `months` if set.
4. Matches all given filters (unset item fields match).

**Weight** (multiplicative, constants in one config file):
- Base `1.0`
- Age: `1 + log2(1 + days_since(created or last log entry) / 30)` — old ideas bubble up
- Closing window: `×2` if window ends within 30 days
- Planned: `×1.5`
- Recently suggested to this user (<7 days): `×0.3`
- Repeatable done within last 30 days: `×0.5`

Pick by weighted random. **Always return human-readable `reasons`** explaining the choice (e.g. "On your list for 14 months", "Season ends in 3 weeks", "Matches: indoor, free"). Shown in UI under the suggestion.

**Actions on a suggestion:** *Let's do it* (→ `planned`), *Done* (→ log entry dialog), *Not now* (snooze, default 7 days, configurable), *Never* (→ `archived`), *Another one* (re-roll, excludes already shown in this session).

Pure function over item list + clock + RNG seed → fully unit-testable.

### 4.2 Later: `LlmSuggester`
Not in v1. Same interface; would add weather/calendar context. Feature flag `SUGGESTER=weighted|llm`.

---

## 5. Notifications (Web Push)

- VAPID keys as secrets. Multiple subscriptions per user (one per device), managed in settings. Expired subscriptions (404/410) are pruned.
- iOS: push works only when installed to home screen — UI must explain this when the user enables push in a non-installed Safari.
- **Quiet hours:** per user, default 22:00–08:00. Non-urgent notifications are deferred to end of quiet hours.
- Per-type toggles in settings. Each notification includes a deep link.

| Type | Trigger | Default |
|---|---|---|
| `nudge` | Randomised schedule, see §5.1. Runs the suggester with the user's saved default filters, sends the result | **Off (opt-in)** |
| `window` | Daily at user's 09:00: items whose window **opens** today, or **closes** in 7 days | On |
| `shared` | Activity by *others* on shared lists (item added, `shared` log entry) — batched, at most one push per list per 30 min. Private log entries never notify. | On |
| `agent` | Sent via MCP `send_notification` (§8) | On, max 10/day per user (configurable) |

Cron (every 15 min) evaluates due nudges/window checks per user TZ and flushes `shared` batches. Track `last_sent` per (user, type) to make cron runs idempotent.

### 5.1 Nudge schedule
- **Opt-in.** Nothing is sent until the user enables nudges.
- Settings: `count` (integer ≥ 0) per `period` (`week` | `month`), and an allowed time window (default 09:00–21:00, user TZ, always clipped to quiet hours). `count = 0` = enabled but nothing sent.
- **Max one nudge per day:** `count` is capped at the number of days in the period (7, or the month's length; a stored 31 in February sends 28).
- **Random distribution:** at the start of each period (Monday 00:00 / 1st 00:00, user TZ) the server draws `count` *distinct* days uniformly from the period, and for each a uniformly random minute within the allowed window. Use `crypto.getRandomValues`.
- The draw is persisted in `nudge_slots(user_id, send_at, status)` so cron is idempotent and a restart/redeploy never re-rolls or double-sends. Slot times are not shown to the user (the point is surprise).
- Enabling or changing settings mid-period: discard unsent future slots, redraw for the remaining days with `round(count × remaining_days / period_days)`. Today is eligible only if a valid time remains in today's window.
- **Pause:** indefinitely or until a date (UI shortcuts: 1 week, 1 month, until …). Slots falling inside a pause are skipped, not postponed. Resume redraws like a settings change.
- Slot fires but suggester returns nothing → no push, slot marked `skipped_empty`.
- DST: draw in local time, convert to UTC per slot; nonexistent local times shift forward one hour.

---

## 6. Offline & sync

- Service worker caches app shell (stale-while-revalidate for assets, network-first for API).
- Data mirrored in IndexedDB per user.
- **Reads** work fully offline.
- **Writes** offline go to an outbox (`{op_id, entity, id, fields, field_ts}`), replayed in order on reconnect; `op_id` makes replays idempotent.
- Server resolves conflicts **last-write-wins per field** using `field_clock`. Good enough for an idea list; no CRDT.
- `GET /api/sync?since=<seq>` returns changed entities + tombstones for all lists the user can see, plus new cursor. Losing access to a shared list → tombstones for its items.
- Clock skew: client sends its timestamp; server clamps to `min(client_ts, server_now)`.

---

## 7. Export / import / account deletion

### Export (settings → "Download my data")
Zip containing:
- `someday-export.json` — schema `someday-export/v1` (versioned, JSON Schema committed in repo): user profile/settings (no credentials), lists the user owns, items, tags, **the user's own log entries** (both visibilities, with `visibility` kept); for shared lists not owned: items included with a `shared_from` marker. Other members' log entries are never exported, shared or not — they're their data.
- `markdown/<list-slug>.md` — one readable file per list, grouped by status, with log entries.
- `README.txt` explaining the contents.

Generated synchronously (data volume is small); if it ever exceeds Worker limits, revisit.

### Import
- Accepts `someday-export/v1` JSON. Modes: *into new lists* (default) or *merge into existing list*. All IDs remapped. Dry-run preview showing counts before commit.
- This is also the migration path between instances.

### Account deletion
- Settings → delete account (passkey re-auth required). Owned lists deleted (or ownership transferred to another member if shared — user chooses per list). Hard delete after 30 days grace; immediate logout everywhere.

---

## 8. MCP server

- Endpoint: `POST /mcp`, Streamable HTTP, implementing the **2026-07-28 MCP spec** (stateless core). **Claude Code: read the actual spec text before implementing; do not trust this summary for protocol details.**

### 8.1 Auth (OAuth 2.1, app is its own authorization server)
- Metadata: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.
- Clients identified by **Client ID Metadata Documents** (client_id is an HTTPS URL; fetch, validate, cache 24h). Dynamic Client Registration behind `MCP_ALLOW_DCR=false`.
- Authorization code + PKCE (S256 only). Consent screen requires an active passkey session; shows client name, redirect host and requested scopes; user can narrow scopes and restrict to specific lists.
- Scopes: `someday:read`, `someday:write`, `someday:notify`.
- Tokens: opaque, hashed at rest. Access 1h, refresh 30 days rotating with reuse detection (reuse → revoke family).
- Settings page: list connected clients, scopes, last used, revoke.

### 8.2 Tools
| Tool | Scope | Notes |
|---|---|---|
| `list_lists` | read | |
| `search_items` | read | text, status, tags, context filters, list |
| `get_item` | read | incl. log |
| `suggest` | read | same filters as UI; returns `reasons` |
| `create_item` | write | all item fields |
| `update_item` | write | partial |
| `set_status` | write | |
| `log_done` | write | date, note, rating, `visibility` (`private`/`anonymous`/`shared`, default `private`) |
| `send_notification` | notify | title, body, optional `item_id` deep link; subject to quiet hours + daily cap |

Tool results are compact JSON + short text summary. All MCP writes recorded in `changes` with `actor = oauth_client_id` and shown in the item's history as "via <client name>".

---

## 9. Security & ops

- CSRF: SameSite=Lax + strict `Origin` check on state-changing requests.
- Strict CSP (no inline scripts), HSTS, `X-Content-Type-Options`, `Referrer-Policy: same-origin`.
- Rate limits: auth endpoints, invite redemption, MCP (per token), push sends.
- Authorization checks centralized (`requireListRole(list, 'editor')`) — every query scoped by membership; tests for cross-user access on every endpoint.
- Structured JSON logs; no item content in logs.
- Config: all defaults in `src/config.ts`, overridable via wrangler vars. Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `BOOTSTRAP_ADMIN_TOKEN`, `TOKEN_PEPPER`.

---

## 10. CI/CD (GitHub Actions)

- **PR:** install (bun), typecheck, lint, unit tests, integration tests **against both platform adapters** (Workers pool + Bun/SQLite), build, `podman build` of the container image (build only, not published) so self-hosting can't silently rot.
- **Push to `main`:** same checks; release-please updates the release PR. **Release (merging that PR):** tests → `wrangler d1 migrations apply --remote` → `wrangler deploy` → smoke test. Production gets releases only (decided 2026-10-15; replaces "deploy every push to `main`").
- Optional preview environment (`env.preview`, separate D1) deployed on PR label `preview`.
- Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Document required token permissions in README.
- README: self-hosting guide (fork → create D1 → set secrets → push), consistent with stoppeklokke.
- The deploy pipeline targets Cloudflare only. No image publishing (can be added later as GHCR job behind a flag).

## 10a. Self-hosting with Podman

- `Containerfile`: multi-stage, `oven/bun` slim base, builds frontend + bundles `src/entry/server.ts`. Runs as non-root (uid 1000). Exposes `8080`. `HEALTHCHECK` on `GET /healthz`.
- Data: SQLite at `/data/someday.db` (volume), WAL mode, `busy_timeout=5000`. Migrations run automatically on startup from the same `migrations/` folder, tracked in a `d1_migrations` table (same name/shape wrangler uses, so a DB copied between targets stays consistent).
- Static assets served by Hono (`serveStatic`) with the same cache headers as on CF.
- Rate limiting: in-memory token buckets (single instance assumed; documented).
- Cron: in-process timer every 15 min calling `runScheduled`; idempotency via `last_sent` (§5) makes restarts safe.
- Config via env vars, same names as wrangler vars/secrets; secrets also accepted as `*_FILE` (Podman secrets).
- **`PUBLIC_ORIGIN` is required on both targets** (WebAuthn RP ID/origin, OAuth issuer, push deep links). Container is expected behind a TLS reverse proxy (Caddy example in docs); passkeys need HTTPS.
- Ship `deploy/podman/someday.container` (Quadlet unit) + `deploy/podman/someday.env.example`.
- Backups: documented as `sqlite3 .backup` or volume snapshot; export/import (§7) is the supported migration path between CF and self-hosted instances.

---

## 11. Out of scope for v1 (explicitly)
- Photos/attachments (would need R2; schema leaves room)
- LLM suggester (interface prepared)
- Geo filtering / "near me" (location stored only)
- CRDT-based sync
- Email of any kind
- Comments on items
- Native apps

---

## 12. Milestones

1. **Skeleton:** repo, platform abstraction with both adapters, Containerfile, CI/CD, migrations, passkey auth + bootstrap admin + invites, PWA shell, i18n. (Both targets from day one — retrofitting the abstraction later is where this usually goes wrong.)
2. **Core:** lists, items CRUD, statuses, log, tags, filtering/search.
3. **Suggester:** weighted suggester + UI + reasons.
4. **Offline:** IndexedDB mirror, outbox, sync endpoint.
5. **Sharing + push:** list membership, list invites, all four notification types, cron.
6. **Takeaway:** export zip, import with dry run, account deletion.
7. **MCP:** OAuth AS (CIMD, PKCE, scopes), MCP endpoint + tools, client management UI.
8. **Hardening:** rate limits, CSP, authz test sweep, self-hosting docs.

Each milestone ends deployable with tests green.

---

## 13. Open questions
None currently. Resolved: shared lists included in suggestions by default (§4.1); three-level log visibility with anonymous done-count and group-size threshold (§3.3).
