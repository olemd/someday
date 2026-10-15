// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sharing (§3.1): list invite links, joining, roles, leaving, removing and
 * transferring ownership. Exactly one owner per list (unique index); the
 * owner cannot leave without handing the list over.
 *
 * Membership changes append `member` rows to the change log: one for the
 * remaining members (the member list changed) and, when someone loses
 * access, one addressed only to them (their sync drops the list, §6).
 */
import { randomToken, tokenHash } from '../../core/crypto';
import { HttpError, conflict, notFound } from '../../core/errors';
import { iso, type Stmt } from '../../core/ports';
import { ulid } from '../../core/ulid';
import type { Role } from '../../shared/schemas/items';
import { type Actor, changeStmt } from '../data/changes';
import type { Ctx } from '../types';
import { type Access, memberRole, requireListRole } from './access';

export interface ListInvite {
  id: string;
  role: 'editor' | 'viewer';
  created_at: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked: boolean;
}

function memberChanges(
  ctx: Ctx,
  actor: Actor,
  listId: string,
  userId: string,
  lost: boolean,
): Stmt[] {
  const stmts = [
    changeStmt(ctx, { entity: 'member', entityId: userId, listId, op: 'upsert', actor }),
  ];
  if (lost) {
    stmts.push(
      changeStmt(ctx, {
        entity: 'member',
        entityId: userId,
        listId,
        op: 'delete',
        actor,
        visibleTo: userId,
      }),
    );
  }
  return stmts;
}

export async function createListInvite(
  ctx: Ctx,
  access: Access,
  listId: string,
  opts: { role: 'editor' | 'viewer'; max_uses: number; expires_days?: number },
): Promise<ListInvite & { url: string }> {
  await requireListRole(ctx, access, listId, 'owner');
  const token = randomToken(32);
  const now = ctx.clock.now();
  const id = ulid(now);
  const expiresAt = iso(now + (opts.expires_days ?? ctx.config.LIST_INVITE_TTL_DAYS) * 86_400_000);
  await ctx.db.run(
    `INSERT INTO list_invites (id, list_id, token_hash, role, created_by, created_at, expires_at, max_uses)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    listId,
    await tokenHash(ctx.config.TOKEN_PEPPER, `join:${token}`),
    opts.role,
    access.userId,
    iso(now),
    expiresAt,
    opts.max_uses,
  );
  return {
    id,
    role: opts.role,
    created_at: iso(now),
    expires_at: expiresAt,
    max_uses: opts.max_uses,
    uses: 0,
    revoked: false,
    url: `${ctx.config.PUBLIC_ORIGIN}/join/${token}`,
  };
}

export async function listInvites(ctx: Ctx, access: Access, listId: string): Promise<ListInvite[]> {
  await requireListRole(ctx, access, listId, 'owner');
  const rows = await ctx.db.all<Omit<ListInvite, 'revoked'> & { revoked_at: string | null }>(
    `SELECT id, role, created_at, expires_at, max_uses, uses, revoked_at FROM list_invites
      WHERE list_id = ? ORDER BY created_at DESC LIMIT 50`,
    listId,
  );
  return rows.map(({ revoked_at, ...r }) => ({ ...r, revoked: revoked_at !== null }));
}

export async function revokeListInvite(ctx: Ctx, access: Access, listId: string, id: string) {
  await requireListRole(ctx, access, listId, 'owner');
  const r = await ctx.db.run(
    'UPDATE list_invites SET revoked_at = ? WHERE id = ? AND list_id = ? AND revoked_at IS NULL',
    iso(ctx.clock.now()),
    id,
    listId,
  );
  if (r.changes === 0) throw notFound();
}

interface InviteRow {
  id: string;
  list_id: string;
  role: 'editor' | 'viewer';
  list_name: string;
  inviter: string | null;
}

/** The usable invite behind a join token, or null. */
export async function findJoinInvite(ctx: Ctx, token: string): Promise<InviteRow | null> {
  return ctx.db.first<InviteRow>(
    `SELECT i.id, i.list_id, i.role, l.name AS list_name, u.display_name AS inviter
       FROM list_invites i JOIN lists l ON l.id = i.list_id AND l.deleted_at IS NULL
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.uses < i.max_uses AND i.expires_at > ?`,
    await tokenHash(ctx.config.TOKEN_PEPPER, `join:${token}`),
    iso(ctx.clock.now()),
  );
}

/**
 * Statements that use one invite and add `userId` as a member, atomically:
 * the member row is only inserted while the invite still has uses left, and
 * the use is only counted if that insert happened (batches are transactions,
 * so two people racing for a single-use invite cannot both get in). Usable
 * inside the signup batch: a list invite also lets someone sign up.
 */
export function joinStmts(
  ctx: Ctx,
  invite: { id: string; list_id: string; role: Role },
  userId: string,
): Stmt[] {
  const now = iso(ctx.clock.now());
  const joined = {
    sql: 'EXISTS (SELECT 1 FROM list_members WHERE list_id = ? AND user_id = ? AND joined_at = ?)',
    params: [invite.list_id, userId, now],
  };
  return [
    {
      sql: `INSERT INTO list_members (list_id, user_id, role, joined_at)
            SELECT ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
               AND EXISTS (SELECT 1 FROM list_invites WHERE id = ? AND revoked_at IS NULL
                             AND uses < max_uses AND expires_at > ?)
               AND NOT EXISTS (SELECT 1 FROM list_members WHERE list_id = ? AND user_id = ?)`,
      params: [
        invite.list_id,
        userId,
        invite.role,
        now,
        userId,
        invite.id,
        now,
        invite.list_id,
        userId,
      ],
    },
    {
      sql: `UPDATE list_invites SET uses = uses + 1 WHERE id = ? AND ${joined.sql}`,
      params: [invite.id, ...joined.params],
    },
    changeStmt(
      ctx,
      {
        entity: 'member',
        entityId: userId,
        listId: invite.list_id,
        op: 'upsert',
        actor: { id: userId, kind: 'user' },
      },
      joined,
    ),
  ];
}

export async function joinList(
  ctx: Ctx,
  userId: string,
  token: string,
): Promise<{ list_id: string; already_member: boolean }> {
  const invite = await findJoinInvite(ctx, token);
  if (!invite) throw new HttpError(410, 'invite_invalid', 'This invite is invalid or used up');
  if (await memberRole(ctx, userId, invite.list_id)) {
    return { list_id: invite.list_id, already_member: true };
  }
  await ctx.db.batch(joinStmts(ctx, invite, userId));
  if (!(await memberRole(ctx, userId, invite.list_id))) {
    throw new HttpError(410, 'invite_invalid', 'This invite is invalid or used up');
  }
  return { list_id: invite.list_id, already_member: false };
}

export async function setMemberRole(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  listId: string,
  userId: string,
  role: 'editor' | 'viewer',
) {
  await requireListRole(ctx, access, listId, 'owner');
  const r = await ctx.db.batch([
    {
      sql: "UPDATE list_members SET role = ? WHERE list_id = ? AND user_id = ? AND role != 'owner'",
      params: [role, listId, userId],
    },
    ...memberChanges(ctx, actor, listId, userId, false),
  ]);
  if (r[0]?.changes !== 1) throw notFound('member_not_found');
}

/** Remove a member (owner), or leave (self). The owner must transfer first. */
export async function removeMember(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  listId: string,
  userId: string,
) {
  const myRole = await requireListRole(ctx, access, listId, 'viewer');
  const self = userId === access.userId;
  if (!self && myRole !== 'owner')
    throw new HttpError(403, 'forbidden', 'Only the owner can remove members');
  const theirs = self ? myRole : await memberRole(ctx, userId, listId);
  if (!theirs) throw notFound('member_not_found');
  if (theirs === 'owner') {
    throw conflict('owner_cannot_leave', 'Transfer ownership before leaving the list');
  }
  await ctx.db.batch([
    { sql: 'DELETE FROM list_members WHERE list_id = ? AND user_id = ?', params: [listId, userId] },
    // Pending shared notifications about this list are no longer theirs to see.
    {
      sql: 'DELETE FROM shared_queue WHERE list_id = ? AND recipient = ?',
      params: [listId, userId],
    },
    ...memberChanges(ctx, actor, listId, userId, true),
  ]);
}

export async function transferOwnership(
  ctx: Ctx,
  access: Access,
  actor: Actor,
  listId: string,
  toUserId: string,
) {
  await requireListRole(ctx, access, listId, 'owner');
  if (toUserId === access.userId) return;
  if (!(await memberRole(ctx, toUserId, listId))) throw notFound('member_not_found');
  // Demote first: the unique index allows only one owner at a time.
  await ctx.db.batch([
    {
      sql: "UPDATE list_members SET role = 'editor' WHERE list_id = ? AND user_id = ?",
      params: [listId, access.userId],
    },
    {
      sql: "UPDATE list_members SET role = 'owner' WHERE list_id = ? AND user_id = ?",
      params: [listId, toUserId],
    },
    ...memberChanges(ctx, actor, listId, toUserId, false),
  ]);
}
