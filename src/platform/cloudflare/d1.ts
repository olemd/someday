// SPDX-License-Identifier: AGPL-3.0-or-later
/** D1 adapter for the `Db` port. The only place that knows about D1. */
import type { BatchResult, Db, SqlValue, Stmt } from '../../core/ports';

export function d1Db(d1: D1Database): Db {
  const prep = (sql: string, params: SqlValue[]) => d1.prepare(sql).bind(...params);
  return {
    async all<T>(sql: string, ...params: SqlValue[]) {
      return (await prep(sql, params).all<T>()).results;
    },
    async first<T>(sql: string, ...params: SqlValue[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async run(sql: string, ...params: SqlValue[]) {
      const r = await prep(sql, params).run();
      return { changes: r.meta.changes ?? 0, lastRowId: r.meta.last_row_id ?? 0 };
    },
    async batch(stmts: Stmt[]): Promise<BatchResult[]> {
      if (stmts.length === 0) return [];
      const res = await d1.batch(stmts.map((s) => prep(s.sql, s.params)));
      return res.map((r) => ({
        rows: (r.results ?? []) as Record<string, unknown>[],
        changes: r.meta.changes ?? 0,
        lastRowId: r.meta.last_row_id ?? 0,
      }));
    },
  };
}
