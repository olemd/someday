# Self-hosting Someday with Podman

Someday runs on Cloudflare Workers by default ([README](../README.md#deploy-your-own)). It also runs on your own server: one [Bun](https://bun.sh) process serves the API and the PWA, stores everything in one SQLite file, and runs the scheduled work (nudges, reminders, purges) itself every 15 minutes. The application code is the same; only `src/platform/bun/` differs, and the full test suite runs against both platforms.

## What you need

- A Linux server with Podman, a domain pointing at it, and ports 80/443 open.
- **HTTPS** via a reverse proxy. Passkeys only work in a secure context, and the `__Host-` session cookie requires `Secure`. The example uses [Caddy](https://caddyserver.com).
- `PUBLIC_ORIGIN` set to the public `https://` address. It is the passkey domain, the OAuth issuer and the base for links in notifications.

## 1. Build the image

No image is published; build it from a checkout (CI builds the same image on every PR, so it does not rot):

```sh
git clone https://github.com/olemd/someday && cd someday
BUILDAH_FORMAT=docker podman build \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg GIT_REVISION="$(git describe --always --dirty --abbrev=40)" \
  --build-arg APP_VERSION="$(jq -r .version package.json)" \
  -t localhost/someday:latest .
```

The image runs as uid 1000, exposes port 8080, keeps the database at `/data/someday.db` (WAL mode, `busy_timeout=5000`), applies migrations from `migrations/` on startup (tracked in a `d1_migrations` table, the same as wrangler, so a database copied between targets stays consistent), and has a `HEALTHCHECK` on `GET /healthz`. Build metadata is in `/etc/build-info` and the OCI labels.

## 2. Secrets and configuration

```sh
openssl rand -base64 48 | podman secret create someday-pepper -
mkdir -p ~/.config/someday
cp deploy/podman/someday.env.example ~/.config/someday/someday.env
chmod 600 ~/.config/someday/someday.env
```

Edit the file: set `PUBLIC_ORIGIN`, a `BOOTSTRAP_ADMIN_TOKEN` (`openssl rand -base64 24`) and, for push, VAPID keys (`bun run vapid` in the checkout). Every secret can also be given as `<NAME>_FILE` pointing at a file, which is how the unit passes `TOKEN_PEPPER`. All other settings use the same names as the Cloudflare vars (see `src/core/config.ts`).

## 3. Service (Quadlet)

```sh
mkdir -p ~/.config/containers/systemd
cp deploy/podman/someday.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start someday
loginctl enable-linger "$USER"   # keep it running after logout
```

The unit runs the container read-only, without capabilities, with the database on the `someday-data` volume, published on `127.0.0.1:8080` only.

## 4. Reverse proxy

Use [`deploy/podman/Caddyfile`](../deploy/podman/Caddyfile) (replace the domain). Set `TRUSTED_PROXIES` to the proxy's address as the container sees it, so rate limits see real client addresses; the server logs a warning with the address to add if it receives `X-Forwarded-For` from an untrusted peer.

## 5. First admin

Open `https://<your domain>/setup?token=<BOOTSTRAP_ADMIN_TOKEN>` and create a passkey. Setup disables itself once an admin exists.

## Assistants (MCP)

`https://<your domain>/mcp` works the same as on Cloudflare; see [docs/mcp.md](mcp.md). The server fetches client metadata documents from the internet when a client connects; it refuses private, loopback and IP-literal addresses.

## Operations

- **Health**: `GET /healthz` (liveness) and `GET /api/health` (version, git SHA, configuration problems).
- **Backups**: `podman exec someday bun -e "new (require('bun:sqlite').Database)('/data/someday.db').run(\"VACUUM INTO '/data/backup.db'\")"`, or `sqlite3 someday.db ".backup backup.db"` on the volume, or a volume snapshot. The supported way to move between Cloudflare and a self-hosted instance is the in-app export/import.
- **Rate limits** are in memory: a single instance is assumed, and a restart resets the counters.
- **Scheduled work** runs in-process every 15 minutes (aligned to the quarter hour). It is idempotent, so restarts never double-send.
- **Updates**: pull the new code, rebuild the image, `systemctl --user restart someday`. Migrations run on start.
