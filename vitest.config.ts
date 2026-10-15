// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tests run inside workerd with a local D1 (§2): `bun run test`, never `bun test`.
 * Bindings are declared here rather than read from wrangler.jsonc, so tests
 * work without a rendered config (the template is fork-specific).
 */
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { RUN_WORKER_FIRST, TEST_ENV } from './test/test-env';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        main: './src/platform/cloudflare/worker.ts',
        miniflare: {
          compatibilityDate: '2026-08-15',
          d1Databases: ['DB'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...TEST_ENV,
          },
          // Mirrors wrangler.template.jsonc so asset routing is tested as deployed.
          assets: {
            directory: './test/fixtures/assets',
            binding: 'ASSETS',
            run_worker_first: RUN_WORKER_FIRST,
            assetConfig: { not_found_handling: 'single-page-application' },
          },
        },
      }),
    ],
    resolve: {
      // The shared suite talks to D1 here; vitest.bun.config.ts swaps in SQLite.
      alias: {
        '@test/platform': resolve('test/platform/cloudflare.ts'),
      },
    },
    test: {
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts'],
      exclude: ['test/bun/**', '**/node_modules/**'],
    },
  };
});
