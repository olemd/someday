# Self-hosting Someday with Podman

Someday runs on Cloudflare Workers by default ([README](../README.md#deploy-your-own)). It also runs on your own server as one container: the published image `ghcr.io/olemd/someday`, a reverse proxy for HTTPS, and a volume for the database. This page explains [how that works](#how-it-works), how to [set it up](#setting-it-up), every [configuration](#configuration-reference) option, and how to [run it](#operations) (updates, backups, troubleshooting).

## How it works

```
browser / PWA / MCP client
        │  HTTPS
        ▼
 reverse proxy (Caddy)  ── TLS certificate, X-Forwarded-For
        │  HTTP, 127.0.0.1:8080
        ▼
 someday container: one Bun process
   ├─ /api/*, /mcp, /healthz, /oauth/token…  → the same Hono app as the Worker
   ├─ everything else                        → the built PWA (dist/web)
   ├─ every 15 minutes                       → scheduled work (nudges, reminders, purges)
   └─ SQLite /data/someday.db  ── volume someday-data
```

**Same code as on Cloudflare.** All application code (`src/core`, `src/modules`) is shared; only the platform adapter differs (`src/platform/bun/` instead of `src/platform/cloudflare/`). The full test suite runs against both adapters in CI, so the two targets behave the same.

**One process.** `bun dist/server/server.js` serves the API and the PWA from the same origin. Static files get the same security and cache headers as on Cloudflare (both read the same `_headers` file), unknown paths fall back to `index.html`, and a missing `/assets/…` file is a 404 instead of HTML.

**SQLite instead of D1.** D1 is SQLite, so the schema and queries are the same. The database is one file, `/data/someday.db`, in WAL mode with `busy_timeout=5000`. Its `-wal` and `-shm` files live next to it while the server runs; a clean stop folds them back into the main file.

**Migrations on startup.** Before it accepts requests the server applies any new files from `migrations/` (baked into the image) and records them in a `d1_migrations` table, the same table wrangler uses. Migrations only add things, so starting a newer image on an older database is how you upgrade. The log shows `migrations applied` with the file names.

**Scheduled work in-process.** The Worker gets a cron trigger every 15 minutes. The server instead runs the same job itself, aligned to the quarter hour (:00, :15, :30, :45), never two at once. The job is idempotent: a restart, a missed run or a run that happens twice never sends a notification twice.

**Secrets from files.** Every setting can also be given as `<NAME>_FILE`, the path to a file holding the value. The Quadlet unit uses this to pass `TOKEN_PEPPER` as a Podman secret, so it never appears in the environment file.

**Client addresses.** Login, recovery and setup are rate limited per client IP. Behind a proxy, every request comes from the proxy, so the server believes `X-Forwarded-For` only when the request comes from an address in `TRUSTED_PROXIES`. It reads the header right to left, skips trusted hops, and takes the first untrusted address as the client, so a client cannot pick its own address by sending a fake header. If a request carries `X-Forwarded-For` from an address that is not trusted, the server logs a warning once, with the address to add.

**Clean shutdown.** On `SIGTERM` (what `systemctl stop` and `podman stop` send) the server stops accepting connections, waits for background work in flight (push notifications being sent), closes the database and exits.

### Differences from Cloudflare

| | Cloudflare Workers | Self-hosted |
|---|---|---|
| Database | D1 | SQLite file on a volume |
| Scheduled work | Cron trigger every 15 minutes | Timer in the process, every 15 minutes |
| Auth rate limits | Counters in D1, shared by all isolates | In memory: assumes **one** instance; a restart resets them |
| HTTPS | Cloudflare | Your reverse proxy |
| Secrets | `wrangler secret put` | Environment file or `<NAME>_FILE` (Podman secrets) |
| Updates | Each release is deployed by GitHub Actions | `podman auto-update` pulls each release (or pin a version) |
| Backups | D1 Time Travel | Yours: see [Backups](#backups) |

Run one container per database. Two processes on the same file would each have their own rate-limit counters and each run the scheduled work (still idempotent, but wasteful).

## Setting it up

### What you need

- A Linux server with Podman (rootless works), a domain pointing at it, and ports 80/443 open.
- **HTTPS** via a reverse proxy. Passkeys only work in a secure context, and the `__Host-` session cookie requires `Secure`. The example uses [Caddy](https://caddyserver.com), which gets certificates by itself.

You do not need a checkout of the code: everything below runs against the image.

### 1. The image

Every release is published as `ghcr.io/olemd/someday:<version>` and `:latest`, built from the same Containerfile and smoke-tested first:

```sh
podman pull ghcr.io/olemd/someday:latest
```

The image runs as uid 1000, listens on port 8080, keeps the database at `/data/someday.db`, and has a `HEALTHCHECK` on `GET /healthz`. The version and commit are in `/etc/build-info` and the OCI labels (`podman inspect`).

<details>
<summary>Building it yourself instead (e.g. a fork with changes)</summary>

```sh
git clone https://github.com/olemd/someday && cd someday
BUILDAH_FORMAT=docker podman build \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg GIT_REVISION="$(git describe --always --dirty --abbrev=40)" \
  --build-arg APP_VERSION="$(jq -r .version package.json)" \
  -t localhost/someday:latest .
```

Then use `Image=localhost/someday:latest` in the Quadlet unit and drop `AutoUpdate=registry`.

</details>

### 2. Secrets and configuration

The token pepper goes into a Podman secret; the rest goes into an environment file:

```sh
openssl rand -base64 48 | podman secret create someday-pepper -
mkdir -p ~/.config/someday
curl -fsSL https://raw.githubusercontent.com/olemd/someday/main/deploy/podman/someday.env.example \
  -o ~/.config/someday/someday.env
chmod 600 ~/.config/someday/someday.env
```

Edit `~/.config/someday/someday.env`:

- `PUBLIC_ORIGIN`: your `https://` address, without a trailing slash.
- `BOOTSTRAP_ADMIN_TOKEN`: a one-time token for creating the first admin (`openssl rand -base64 24`).
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` for push notifications (optional). Generate them with the image:

  ```sh
  podman run --rm --entrypoint bun ghcr.io/olemd/someday:latest -e "
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const raw = await crypto.subtle.exportKey('raw', k.publicKey);
    console.log('VAPID_PUBLIC_KEY=' + Buffer.from(raw).toString('base64url'));
    console.log('VAPID_PRIVATE_KEY=' + (await crypto.subtle.exportKey('jwk', k.privateKey)).d);"
  ```

  Keep them: new keys invalidate every existing push subscription.

See the [configuration reference](#configuration-reference) for everything else.

### 3. Service (Quadlet)

```sh
mkdir -p ~/.config/containers/systemd
curl -fsSL https://raw.githubusercontent.com/olemd/someday/main/deploy/podman/someday.container \
  -o ~/.config/containers/systemd/someday.container
systemctl --user daemon-reload
systemctl --user start someday
loginctl enable-linger "$USER"   # keep it running after logout
```

[The unit](../deploy/podman/someday.container) runs the container read-only, without capabilities, with the database on the `someday-data` volume, published on `127.0.0.1:8080` only. Check that it started:

```sh
systemctl --user status someday
curl -s http://127.0.0.1:8080/api/health    # "config_errors": [] when the configuration is valid
```

### 4. Reverse proxy

Use [`deploy/podman/Caddyfile`](../deploy/podman/Caddyfile) and replace the domain. Then set `TRUSTED_PROXIES` to the proxy's address as the container sees it. With Caddy on the same host and the port published on `127.0.0.1`, the default in the example file (`127.0.0.1,::1`) is usually right. If the log says `X-Forwarded-For from an untrusted address`, add the `proxy_address` it shows and restart.

### 5. First admin

Open `https://<your domain>/setup?token=<BOOTSTRAP_ADMIN_TOKEN>` and create a passkey. Setup turns itself off once an admin exists; you can then remove `BOOTSTRAP_ADMIN_TOKEN` from the environment file. New users join through invites (or open registration, see `REGISTRATION_MODE`).

### Without Podman

The server is a single file for [Bun](https://bun.sh). From a checkout: `bun install && bun run build`, put the settings in `.env` (Bun reads it), and run `bun run start` under systemd or another supervisor. The defaults then are `HOST=127.0.0.1`, `PORT=8080`, `DATABASE_PATH=./data/someday.db`, `STATIC_DIR=./dist/web` and `MIGRATIONS_DIR=./migrations`.

## Configuration reference

Settings are environment variables with the same names as the Cloudflare vars and secrets, so a configuration carries over between targets. Any of them can be given as `<NAME>_FILE` instead. Empty values count as unset. Invalid values do not stop the server: an invalid optional setting falls back to its default, a missing or invalid required one leaves the app unusable but `/api/health` still answers. Either way the server logs `configuration problems` at startup and lists them under `config_errors` in `GET /api/health`. The defaults are in [`src/core/config.ts`](../src/core/config.ts).

**Required**

| Name | Meaning |
|---|---|
| `PUBLIC_ORIGIN` | The public address, e.g. `https://someday.example.com` (no path, no trailing slash, `https` except on `localhost`). It is the passkey domain, the OAuth issuer and the base for links in notifications. **Changing the host name later makes every existing passkey stop working**, since passkeys are bound to it. |
| `TOKEN_PEPPER` | Secret, at least 32 characters. Mixed into every stored token hash. Changing it signs everyone out and invalidates invites, device links and connected assistants. |

**Secrets and identity**

| Name | Default | Meaning |
|---|---|---|
| `BOOTSTRAP_ADMIN_TOKEN` | – | At least 16 characters; enables `/setup?token=…` until an admin exists. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | – | Web Push keys; both or neither. Without them, notifications are off. |
| `VAPID_SUBJECT` | `PUBLIC_ORIGIN` | Contact for push services: `mailto:…` or `https:…`. |
| `RP_NAME` | `Someday` | The name passkey dialogs show. |
| `SOURCE_URL` | `https://github.com/olemd/someday` | The source link in the footer. **Point it at your own repository if you run a modified version** (AGPL §13). |

**Registration and sign-in**

| Name | Default | Meaning |
|---|---|---|
| `REGISTRATION_MODE` | `invite` | `invite` (by invite link), `open` (anyone) or `closed` (no new accounts). |
| `INVITES_ADMIN_ONLY` | `false` | Only admins may create invites. |
| `INVITE_TTL_DAYS` | `7` | How long an invite link is valid. |
| `OPEN_REGISTRATIONS_PER_HOUR` | `5` | Sign-ups per IP per hour in `open` mode. |
| `DEVICE_LINK_TTL_MIN` | `15` | How long a link for adding a device is valid. |
| `SESSION_TTL_DAYS` | `90` | Session lifetime. |
| `AUTH_RATE_LIMIT` | `30` | Sign-in, recovery, setup and link-code attempts per IP per 10 minutes. |
| `RECOVERY_PBKDF2_ITERATIONS` | `2000` | Hashing cost for recovery codes (1 000–100 000). The low default is for Cloudflare's free tier. **Changing it makes existing recovery codes stop working**, so set it before people sign up, or ask them to create new codes. |

**Lists, suggestions and notifications**

| Name | Default | Meaning |
|---|---|---|
| `ANON_COUNT_MIN_MEMBERS` | `4` | Shared lists show the anonymous "done by N" count from this many members (at least 3). |
| `LIST_INVITE_TTL_DAYS` | `7` | How long a list invite is valid. |
| `DELETE_GRACE_DAYS` | `30` | Days a deleted list or account can be restored before it is purged. |
| `SUGGESTER` | `weighted` | The suggestion algorithm (`llm` is reserved for later). |
| `SNOOZE_DAYS` | `7` | Default snooze length. |
| `SHARED_PUSH_INTERVAL_MIN` | `30` | Activity on shared lists is batched into one notification per this many minutes. |
| `AGENT_NOTIFY_DAILY_MAX` | `10` | Notifications an assistant may send a user per day. |

**Assistants (MCP)**

| Name | Default | Meaning |
|---|---|---|
| `MCP_ALLOW_DCR` | `false` | Allow OAuth Dynamic Client Registration in addition to client metadata documents. |
| `MCP_RATE_LIMIT_PER_MIN` | `120` | MCP requests per connected client per minute. |

**Server only** (not used on Cloudflare; the image sets the paths)

| Name | Default | In the image | Meaning |
|---|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` | Address to listen on. |
| `PORT` | `8080` | `8080` | Port to listen on. |
| `DATABASE_PATH` | `./data/someday.db` | `/data/someday.db` | The SQLite file; its directory is created if missing. |
| `STATIC_DIR` | `./dist/web` | `/app/web` | The built PWA. |
| `MIGRATIONS_DIR` | `./migrations` | `/app/migrations` | SQL migrations applied at startup. |
| `TRUSTED_PROXIES` | empty | – | Comma-separated IPs or CIDRs of your reverse proxy. Empty: the socket address is the client. |

`APP_VERSION` and `GIT_SHA` are set by the build and shown in `/api/health`; you do not set them.

## Operations

### Health and logs

- `GET /healthz`: liveness, used by the container's `HEALTHCHECK` (`podman healthcheck run someday`).
- `GET /api/health`: version, git SHA and `config_errors`.
- Logs are JSON lines on stdout: `journalctl --user -u someday` (or `podman logs someday`).

### Updates

The unit has `AutoUpdate=registry`. Turn on the timer once and each new release is pulled (daily) and the container restarted with it:

```sh
systemctl --user enable --now podman-auto-update.timer
podman auto-update --dry-run     # see what it would update
```

Migrations run on startup, so there is nothing else to do. To update by hand instead, pin a version in `Image=` (e.g. `ghcr.io/olemd/someday:0.2.0`), change it, `systemctl --user daemon-reload` and `systemctl --user restart someday`. What changed: the [CHANGELOG](../CHANGELOG.md). Take a backup before a big jump.

### Backups

Copy the database while the server runs with SQLite's `VACUUM INTO`, which writes a consistent snapshot, then copy it out of the volume:

```sh
podman exec someday bun -e "const { Database } = require('bun:sqlite');
  new Database('/data/someday.db').run(\"VACUUM INTO '/data/backup.db'\")"
podman cp someday:/data/backup.db ./someday-$(date +%F).db
podman exec someday bun -e "require('node:fs').unlinkSync('/data/backup.db')"
```

Do not just copy `someday.db` from a running server: recent writes may still be in the `-wal` file. Run the commands from a systemd timer or cron for regular backups, and keep the copies somewhere else. The backup contains everything, including session and token hashes; keep `TOKEN_PEPPER` with it, since without the same pepper all sessions and links are invalid (data is not lost, people just sign in again).

### Restore

```sh
systemctl --user stop someday
podman run --rm -v someday-data:/data:Z -v ./someday-2026-10-15.db:/restore.db:ro,Z \
  --entrypoint cp ghcr.io/olemd/someday:latest /restore.db /data/someday.db
systemctl --user start someday
```

A clean stop leaves no `-wal`/`-shm` files behind. If the server crashed instead, remove `someday.db-wal` and `someday.db-shm` from the volume before starting, or SQLite would apply them to the restored file. An older backup on a newer image is fine: missing migrations are applied on startup.

### Moving between Cloudflare and your own server

Each user downloads their data in the app (**Settings → Your data → Download zip**: JSON and Markdown) and imports the zip on the other instance (**Settings → Your data → Import**, which shows what will be added before anything changes). This is the supported path; the format is described in [someday-export-v1.schema.json](someday-export-v1.schema.json). Passkeys are bound to the host name, so on a new domain everyone creates a new passkey.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Creating or using a passkey fails | `PUBLIC_ORIGIN` does not match the address in the browser exactly, or the site is not served over HTTPS. Check `/api/health` for `config_errors`. |
| Everyone gets "too many attempts" at the same time | The server sees every client as the proxy. Set `TRUSTED_PROXIES` (see the `X-Forwarded-For from an untrusted address` warning in the log). |
| No push notifications | VAPID keys missing or only one set (`/api/health`), or the user has not turned on notifications on that device. iOS only allows push for the PWA added to the home screen. |
| The container does not start after an update | `journalctl --user -u someday`: a failed migration or an unreadable `/data` (the volume must be writable by uid 1000). Pin the previous version in `Image=` while you investigate. |
| `/setup` says "Setup is already done" or "That setup token is not valid" | An admin exists already, or the token in the link does not match `BOOTSTRAP_ADMIN_TOKEN` (at least 16 characters; check `config_errors`). |

## Assistants (MCP)

`https://<your domain>/mcp` works the same as on Cloudflare; see [mcp.md](mcp.md). When an assistant connects, the server fetches its client metadata document from the internet; it refuses private, loopback and IP-literal addresses.
