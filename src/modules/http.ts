// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small helpers for declaring OpenAPI routes concisely. */
import type { z } from 'zod';

export const json = <T extends z.ZodType>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});

export const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

/** Convert 0/1 integer columns to booleans for API output. */
export function bool(v: number | null): boolean | null {
  return v === null ? null : v === 1;
}

/** Convert an optional boolean input to the 0/1/NULL column value. */
export function bit(v: boolean | null | undefined): number | null | undefined {
  return v === undefined ? undefined : v === null ? null : v ? 1 : 0;
}

/**
 * Build `SET a = ?, b = ?` from a patch object, skipping undefined values.
 * Column names come from code (allow-list), never from user input.
 */
export function setClause(
  patch: Record<string, string | number | null | undefined>,
  allowed: readonly string[],
): { sql: string; params: (string | number | null)[] } {
  const cols: string[] = [];
  const params: (string | number | null)[] = [];
  for (const k of allowed) {
    const v = patch[k];
    if (v !== undefined) {
      cols.push(`${k} = ?`);
      params.push(v);
    }
  }
  return { sql: cols.join(', '), params };
}
