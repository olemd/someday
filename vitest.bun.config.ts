// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The same integration suite against the self-hosted platform: SQLite via
 * bun:sqlite and the real migration runner (`bun run test:bun`). Runs vitest
 * on the Bun runtime, since bun:sqlite only exists there. Cloudflare-only
 * tests (Worker entry, Static Assets) are excluded; Bun-only ones added.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@test/platform': resolve('test/platform/bun.ts') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/cloudflare/**', '**/node_modules/**'],
    pool: 'forks',
    // Under Bun, vitest's default-export interop drops re-exported namespaces
    // (zod's `export { z }`), so modules are used as Bun loads them.
    deps: { interopDefault: false },
  },
});
