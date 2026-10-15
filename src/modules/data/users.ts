// SPDX-License-Identifier: AGPL-3.0-or-later
/** Creating users: the user row, initial settings and the default list, as one batch. */
import { iso, type Stmt } from '../../core/ports';
import { ulid } from '../../core/ulid';
import type { Ctx } from '../types';
import { changeStmt } from './changes';

export const DEFAULT_LIST_NAME = 'Someday';

export interface NewUser {
  id: string;
  displayName: string;
  role: 'admin' | 'user';
  handle: string;
  settings: Record<string, unknown>;
}

/**
 * Statements creating a user. The user INSERT is gated by `gate` (e.g. "no
 * admin exists yet", "this invite was claimed by this user"); everything
 * after it is gated on the user row existing, so a lost race writes nothing.
 */
export function newUserStmts(
  ctx: Ctx,
  u: NewUser,
  gate?: { sql: string; params: (string | number | null)[] },
): Stmt[] {
  const now = iso(ctx.clock.now());
  const listId = ulid(ctx.clock.now());
  const exists = 'EXISTS (SELECT 1 FROM users WHERE id = ?)';
  const stmts: Stmt[] = [
    {
      sql: `INSERT INTO users (id, display_name, role, webauthn_handle, created_at)
            SELECT ?, ?, ?, ?, ? ${gate ? `WHERE ${gate.sql}` : ''}`,
      params: [u.id, u.displayName, u.role, u.handle, now, ...(gate?.params ?? [])],
    },
    ...Object.entries(u.settings).map(([k, v]) => ({
      sql: `INSERT INTO user_settings (user_id, key, value) SELECT ?, ?, ? WHERE ${exists}`,
      params: [u.id, k, JSON.stringify(v), u.id],
    })),
    {
      sql: `INSERT INTO lists (id, name, created_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ? WHERE ${exists}`,
      params: [listId, DEFAULT_LIST_NAME, u.id, now, now, u.id],
    },
    {
      sql: `INSERT INTO list_members (list_id, user_id, role, joined_at)
            SELECT ?, ?, 'owner', ? WHERE ${exists}`,
      params: [listId, u.id, now, u.id],
    },
  ];
  stmts.push(
    changeStmt(
      ctx,
      { entity: 'list', entityId: listId, listId, op: 'upsert', actor: { id: u.id, kind: 'user' } },
      { sql: exists, params: [u.id] },
    ),
  );
  return stmts;
}
