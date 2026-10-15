// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Applies migrations/*.sql in name order at startup, each in its own
 * transaction. Bookkeeping uses the same `d1_migrations` table as wrangler, so
 * a database exported from D1 (`wrangler d1 export`) continues seamlessly.
 */
import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function applyMigrations(sqlite: Database, dir: string): string[] {
  sqlite.run(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const done = new Set(
    (sqlite.query('SELECT name FROM d1_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), 'utf8');
    sqlite.transaction(() => {
      sqlite.run(sql);
      sqlite.query('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
    })();
    applied.push(name);
  }
  return applied;
}
