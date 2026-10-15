// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-hosted entry point: `bun dist/server/server.js` (or
 * `bun src/platform/bun/server.ts` in development). See docs/self-hosting.md.
 *
 * One process serves the API and the PWA, runs migrations at startup and the
 * scheduled work every 15 minutes (the Worker's cron trigger). Put it behind
 * a TLS reverse proxy: passkeys and the __Host- cookie require HTTPS.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { consoleLogger } from '../../core/ports';
import { clientIpFrom, inCidrs, readServerEnv, resolveFileSecrets } from './env';
import { applyMigrations } from './migrate';
import { createRuntime } from './runtime';
import { openDatabase } from './sqlite';

const CRON_INTERVAL_MS = 15 * 60 * 1000;
const log = consoleLogger;
const env = resolveFileSecrets(process.env as Record<string, string | undefined>, (p) =>
  readFileSync(p, 'utf8'),
);
const server = readServerEnv(env);

if (server.databasePath !== ':memory:')
  mkdirSync(dirname(server.databasePath), { recursive: true });
const sqlite = openDatabase(server.databasePath);
const applied = applyMigrations(sqlite, server.migrationsDir);
if (applied.length) log.info('migrations applied', { applied });

const runtime = createRuntime({ sqlite, env, staticDir: server.staticDir, log });
if (runtime.configErrors.length)
  log.warn('configuration problems', { errors: runtime.configErrors });

// Behind a proxy that is not in TRUSTED_PROXIES every client shares the
// proxy's address, so one burst of failed logins would lock everyone out.
// Say so once, with the address to add (it depends on the network setup).
let warnedProxy = false;
const http = Bun.serve({
  port: server.port,
  hostname: server.host,
  fetch(req, srv) {
    const peer = srv.requestIP(req)?.address;
    if (
      !warnedProxy &&
      req.headers.has('x-forwarded-for') &&
      !(peer && inCidrs(peer, server.trustedProxies))
    ) {
      warnedProxy = true;
      log.warn('X-Forwarded-For from an untrusted address; add your proxy to TRUSTED_PROXIES', {
        proxy_address: peer,
      });
    }
    return runtime.fetch(req, clientIpFrom(req, peer, server.trustedProxies));
  },
});
log.info('listening', {
  url: `http://${http.hostname}:${http.port}`,
  origin: runtime.config.PUBLIC_ORIGIN,
});

// Cron: aligned to 15-minute boundaries like Cloudflare's trigger; never overlapping.
let cronRunning = false;
const tick = async () => {
  if (cronRunning) return;
  cronRunning = true;
  try {
    await runtime.cron();
  } catch (err) {
    log.error('cron failed', { err: String(err) });
  } finally {
    cronRunning = false;
  }
};
let interval: ReturnType<typeof setInterval> | undefined;
const timeout = setTimeout(
  () => {
    void tick();
    interval = setInterval(() => void tick(), CRON_INTERVAL_MS);
  },
  CRON_INTERVAL_MS - (Date.now() % CRON_INTERVAL_MS),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  clearTimeout(timeout);
  if (interval) clearInterval(interval);
  await http.stop();
  await runtime.drain();
  sqlite.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
