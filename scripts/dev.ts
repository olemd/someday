// SPDX-License-Identifier: AGPL-3.0-or-later
export {};
/**
 * Local development (§12): `vite build --watch` writes dist/web, and
 * `wrangler dev` serves it together with the API on http://localhost:8787,
 * with a local D1. One origin, same as production, so passkeys and cookies
 * behave identically. Passkeys work on localhost without HTTPS.
 */
const procs = [
  Bun.spawn(['bunx', 'vite', 'build', '--watch', '--mode', 'development'], {
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
  Bun.spawn(['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], {
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
];
await procs[1]!.exited;
const wrangler = Bun.spawn(['bunx', 'wrangler', 'dev', '--port', '8787'], {
  stdio: ['inherit', 'inherit', 'inherit'],
});
const stop = () => {
  for (const p of [procs[0]!, wrangler]) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race([procs[0]!.exited, wrangler.exited]);
stop();
