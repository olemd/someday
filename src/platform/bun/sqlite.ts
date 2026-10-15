// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SQLite adapter for the `Db` port on Bun (bun:sqlite), the self-hosted
 * counterpart of ../cloudflare/d1.ts.
 *
 * D1 semantics are kept: foreign keys are enforced, and `batch()` is atomic
 * (one transaction: all statements or none). bun:sqlite is synchronous; the
 * port is async, so results are simply wrapped in promises.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { BatchResult, Db, SqlValue, Stmt } from '../../core/ports';

/** Open (or create) the database file with the pragmas the app relies on. */
export function openDatabase(path: string): Database {
  const sqlite = new Database(path, { create: true, strict: true });
  // WAL: readers never block the writer; good for a long-running server.
  if (path !== ':memory:') sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA foreign_keys = ON'); // D1 enforces foreign keys; SQLite does not by default
  sqlite.run('PRAGMA busy_timeout = 5000');
  sqlite.run('PRAGMA synchronous = NORMAL'); // safe with WAL, much faster than FULL
  return sqlite;
}

const bind = (params: SqlValue[]) =>
  params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p)) as SQLQueryBindings[];

export function sqliteDb(sqlite: Database): Db {
  /** Run one statement; statements that produce rows (SELECT, RETURNING) return them. */
  const exec = (s: Stmt): BatchResult => {
    const q = sqlite.query(s.sql);
    if (q.columnNames.length > 0) {
      const rows = q.all(...bind(s.params)) as Record<string, unknown>[];
      return { rows, changes: /^\s*select/i.test(s.sql) ? 0 : rows.length, lastRowId: 0 };
    }
    const r = q.run(...bind(s.params));
    return { rows: [], changes: r.changes, lastRowId: Number(r.lastInsertRowid) };
  };

  return {
    async all<T>(sql: string, ...params: SqlValue[]) {
      return sqlite.query(sql).all(...bind(params)) as T[];
    },
    async first<T>(sql: string, ...params: SqlValue[]) {
      return (sqlite.query(sql).get(...bind(params)) as T | null) ?? null;
    },
    async run(sql: string, ...params: SqlValue[]) {
      const r = exec({ sql, params });
      return { changes: r.changes, lastRowId: r.lastRowId };
    },
    async batch(stmts: Stmt[]): Promise<BatchResult[]> {
      if (stmts.length === 0) return [];
      return sqlite.transaction(() => stmts.map(exec))();
    },
  };
}
