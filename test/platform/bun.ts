// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test platform: SQLite via bun:sqlite, with the real migration runner. Each
 * test file gets its own in-memory database (vitest runs files in separate
 * processes).
 */
import { applyMigrations } from '../../src/platform/bun/migrate';
import { memoryRateLimiter } from '../../src/platform/bun/ratelimit';
import { openDatabase, sqliteDb } from '../../src/platform/bun/sqlite';
import { TEST_ENV } from '../test-env';

export const PLATFORM = 'bun';
export const sqlite = openDatabase(':memory:');
applyMigrations(sqlite, 'migrations');
export const db = sqliteDb(sqlite);
export const testEnv: Record<string, unknown> = { ...TEST_ENV };
export const makeRateLimiter = memoryRateLimiter;
