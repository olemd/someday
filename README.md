# Someday

> Things I want to do or find out about *some day*.

Not a todo list: a slow-moving collection of ideas, experiences and curiosities — with a **"give me something to do"** button. Runs for free on Cloudflare Workers + D1, or self-hosted as a single Podman container.

English and Norwegian Bokmål; adding a language is one JSON file. Specified in [SPEC.md](SPEC.md).

![Someday suggesting the northern lights, with the reasons it was picked](docs/screenshots/01-give-me-something.png)

**[User guide](docs/user-guide.md)** · [Self-hosting](docs/self-hosting.md) · [Connecting assistants (MCP)](docs/mcp.md) · [Export format](docs/someday-export-v1.schema.json) · [Conventions for contributors](CLAUDE.md) · [Licence](#licence)

## Features

- **Lists** of ideas, private or shared with others (owner / editor / viewer), each idea with optional context: duration, indoor/outdoor, cost, energy, solo/together, a date window and/or a season, links, tags.
- **Give me something**: a weighted random suggestion from what fits right now, always with the reasons ("On your list for 14 months", "Season ends in 3 weeks").
- **Done log** per person, with private / anonymous / shared visibility and an anonymous "done by N" count on larger shared lists.
- **Notifications** (Web Push): opt-in random nudges, season/window reminders, shared-list activity, and messages from connected assistants — all respecting quiet hours.
- **Offline first**: an installable PWA that reads and writes offline and syncs when back online.
- **MCP server** with OAuth 2.1 so assistants can search, suggest, add and log ideas.
- **Your data**: export (JSON + Markdown, zipped), import with dry run, account deletion.
- **Passkeys only** (no passwords, no email), with one-time links to add devices across ecosystems, recovery codes and session management.
- Built to WCAG 2.2 AA, dark mode, 24-hour clock.

## Deploy your own

Two targets from the same code:

- **Cloudflare Workers** (below): free tier, deployed automatically for each release.
- **Your own server** with Podman, from the image `ghcr.io/olemd/someday` published with every release (`podman auto-update` keeps it current): see **[docs/self-hosting.md](docs/self-hosting.md)**.

### On Cloudflare

You need a Cloudflare account (the free plan is enough), [Bun](https://bun.sh) (pinned in `package.json`), Node.js ≥ 20 (wrangler runs on Node) and, for continuous deployment, the [GitHub CLI](https://cli.github.com). A custom domain is optional; without one Someday runs on `*.workers.dev`.

```sh
git clone https://github.com/<you>/someday && cd someday
bun install
bunx wrangler login
gh auth login          # optional: lets bootstrap configure the GitHub repo
bun run bootstrap
```

`bootstrap` asks for a Worker name, an optional custom domain and your source URL, then:

1. creates the D1 database (and reuses it on later runs) and applies the migrations,
2. builds and deploys the Worker; without a custom domain the `*.workers.dev` address becomes `PUBLIC_ORIGIN`,
3. generates and stores the Worker secrets `TOKEN_PEPPER`, `BOOTSTRAP_ADMIN_TOKEN` and the VAPID keys (existing ones are kept),
4. optionally sets up the `preview` environment with its own database,
5. with `gh`: sets the GitHub Variables, the `CLOUDFLARE_ACCOUNT_ID` secret and the `CLOUDFLARE_API_TOKEN` secret. For the token it prints a link to Cloudflare's "Create API token" page with the needed permissions filled in; you create the token there and paste it, bootstrap checks it against your account and passes it straight to `gh` (it is never written to disk),
6. checks `/api/health` and prints the `/setup?token=…` link for creating the first admin.

It is safe to run again, for example to add the GitHub settings later. Without `gh`, it prints the values to set by hand.

<details>
<summary>Doing it by hand instead</summary>

1. `bunx wrangler d1 create someday` and note the `database_id`.
2. Copy `.env.example` to `.env`, set `PUBLIC_ORIGIN` (no trailing slash) and `D1_DATABASE_ID`, then `bun run render-config`.
3. Secrets:
   ```sh
   openssl rand -base64 48 | bunx wrangler secret put TOKEN_PEPPER
   openssl rand -base64 24 | tee /dev/stderr | bunx wrangler secret put BOOTSTRAP_ADMIN_TOKEN
   bun run vapid   # then `bunx wrangler secret put VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
   ```
4. `bunx wrangler d1 migrations apply DB --remote && bun run build && bunx wrangler deploy`.
5. Open `https://<your origin>/setup?token=<BOOTSTRAP_ADMIN_TOKEN>`.

</details>

### Continuous deployment from GitHub

Every PR and push runs CI: typecheck, lint, i18n check, the test suite against **both** platform adapters (Workers pool with D1, and Bun with SQLite), build, licence check, and a Podman image build with a smoke test (build only, nothing is published).

Production gets **releases only**. [release-please](https://github.com/googleapis/release-please) keeps a release pull request up to date from the [Conventional Commits](https://www.conventionalcommits.org/) on `main` (`feat` → minor, `fix` → patch; `docs`, `chore`, `test`, `ci` do not release). Merging it tags the release, writes the CHANGELOG, runs `deploy.yml` (tests on both platforms, D1 migrations, deploy, and a smoke test of `/api/health` for the released commit), and publishes the container image `ghcr.io/<owner>/<repo>:<version>` and `:latest` after a smoke test. To redeploy a release by hand: `gh workflow run deploy.yml -f ref=v0.2.0`. Release PRs need **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** (`bun run bootstrap` turns it on).

Set these in **Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | [API token](https://dash.cloudflare.com/profile/api-tokens) with **Account → Workers Scripts: Edit**, **Account → D1: Edit**, **Account → Account Settings: Read**, and for a custom domain **Zone → Workers Routes: Edit** (plus **Zone → DNS: Edit** the first time the custom domain is attached) |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Your account ID |
| `PUBLIC_ORIGIN` | Variable | `https://someday.example.com` |
| `D1_DATABASE_ID` | Variable | The D1 database ID |
| `WORKER_NAME` | Variable | Optional, default `someday` |
| `CUSTOM_DOMAIN` | Variable | Optional, e.g. `someday.example.com` (zone must be on Cloudflare) |
| `SOURCE_URL` | Variable | Your fork's URL (see Licence) |
| `PREVIEW_ORIGIN`, `D1_PREVIEW_DATABASE_ID` | Variables | Optional: PRs labelled `preview` deploy to the `preview` environment with its own D1 |

Without `CLOUDFLARE_API_TOKEN` the deploy workflow skips with a notice, so forks keep a green CI. `wrangler.jsonc` is never committed: it is rendered from `wrangler.template.jsonc` and these values.

## Configuration

The Worker runs scheduled work (nudges, reminders, shared-list batches, purges) from a cron trigger every 15 minutes; the container does the same in-process.

Every default lives in [`src/core/config.ts`](src/core/config.ts) and can be overridden with a wrangler var or environment variable of the same name (e.g. `REGISTRATION_MODE=open`, `DEVICE_LINK_TTL_MIN=10`, `ANON_COUNT_MIN_MEMBERS=5`). Per-user defaults (quiet hours, nudges, snooze length) are changed in the app's settings. `GET /api/health` lists configuration problems.

## Development

```sh
bun install
cp .dev.vars.example .dev.vars
bun run dev            # http://localhost:8787 (local D1; passkeys work on localhost)
bun run test           # vitest in the Workers runtime — never `bun test`
bun run test:bun       # the same suite against the self-hosted platform (SQLite on Bun)
bun run lint && bun run typecheck && bun run i18n:check && bun run build
bun run e2e            # Playwright against the self-hosted server, with a virtual passkey
                       # (CHROMIUM_PATH=/usr/bin/chromium to use an installed Chromium)
bun run screenshots    # regenerate docs/screenshots with demo data (same requirements)
```

## Licence

[AGPL-3.0-or-later](LICENSE). The footer of every page links to the source code (`SOURCE_URL`), as AGPL §13 requires for network use. **If you run a modified version, point `SOURCE_URL` at your own repository.**
