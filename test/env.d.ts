// SPDX-License-Identifier: AGPL-3.0-or-later
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      TEST_MIGRATIONS: D1Migration[];
      PUBLIC_ORIGIN: string;
      TOKEN_PEPPER: string;
      BOOTSTRAP_ADMIN_TOKEN: string;
    }
  }
}
