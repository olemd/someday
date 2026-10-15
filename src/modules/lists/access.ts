// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Centralised authorisation (§9): every list-scoped query goes through
 * `requireListRole`. Non-members get 404 (a list's existence is not revealed),
 * members with too low a role get 403.
 */
import { HttpError, notFound } from '../../core/errors';
import type { Role } from '../../shared/schemas/items';
import type { Ctx } from '../types';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Who is acting: the user, and for OAuth clients the lists the grant is
 * restricted to (null = all the user's lists).
 */
export interface Access {
  userId: string;
  listIds: string[] | null;
}

export async function memberRole(ctx: Ctx, userId: string, listId: string): Promise<Role | null> {
  const row = await ctx.db.first<{ role: Role }>(
    `SELECT m.role FROM list_members m JOIN lists l ON l.id = m.list_id
      WHERE m.list_id = ? AND m.user_id = ? AND l.deleted_at IS NULL`,
    listId,
    userId,
  );
  return row?.role ?? null;
}

export async function requireListRole(
  ctx: Ctx,
  access: Access,
  listId: string,
  min: Role,
): Promise<Role> {
  if (access.listIds && !access.listIds.includes(listId)) throw notFound('list_not_found');
  const role = await memberRole(ctx, access.userId, listId);
  if (!role) throw notFound('list_not_found');
  if (!roleAtLeast(role, min)) {
    throw new HttpError(403, 'forbidden', `This needs the ${min} role on the list`);
  }
  return role;
}

/** SQL fragment + params limiting `<alias>.list_id` to an OAuth grant's lists. */
export function restrictLists(alias: string, access: Access): { sql: string; params: string[] } {
  if (!access.listIds) return { sql: '', params: [] };
  if (access.listIds.length === 0) return { sql: ' AND 0', params: [] };
  return {
    sql: ` AND ${alias}.list_id IN (${access.listIds.map(() => '?').join(', ')})`,
    params: access.listIds,
  };
}
