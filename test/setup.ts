// SPDX-License-Identifier: AGPL-3.0-or-later
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
