// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account deletion (§7): needs a fresh passkey assertion. Owned lists are
 * deleted, or handed to another member when shared (the user chooses per
 * list). Logout everywhere is immediate; the account and everything that
 * cascades from it is hard-deleted after DELETE_GRACE_DAYS.
 */
import { HttpError, conflict } from '../../core/errors';
import { iso, type Stmt } from '../../core/ports';
import { type Actor, changeStmt } from '../data/changes';
import type { Ctx } from '../types';

export interface OwnedShared {
  id: string;
  name: string;
  members: { user_id: string; display_name: string }[];
}

/** Shared lists the user owns: each needs a decision (delete or transfer). */
export async function ownedSharedLists(ctx: Ctx, userId: string): Promise<OwnedShared[]> {
  const rows = await ctx.db.all<{ id: string; name: string; members: string }>(
    `SELECT l.id, l.name,
            (SELECT json_group_array(json_object('user_id', m2.user_id, 'display_name', u.display_name))
               FROM list_members m2 JOIN users u ON u.id = m2.user_id
              WHERE m2.list_id = l.id AND m2.user_id != ?1) AS members
       FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ?1 AND m.role = 'owner'
      WHERE l.deleted_at IS NULL
        AND (SELECT COUNT(*) FROM list_members WHERE list_id = l.id) > 1`,
    userId,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, members: JSON.parse(r.members) }));
}

export type ListDecision = 'delete' | { transfer_to: string };

export async function deleteAccount(
  ctx: Ctx,
  userId: string,
  decisions: Record<string, ListDecision>,
): Promise<void> {
  const shared = await ownedSharedLists(ctx, userId);
  const missing = shared.filter((l) => !decisions[l.id]);
  if (missing.length) {
    throw conflict('decision_required', 'Choose what happens to each shared list you own', {
      lists: missing.map((l) => l.id),
    });
  }
  const now = iso(ctx.clock.now());
  const actor: Actor = { id: userId, kind: 'user' };
  const stmts: Stmt[] = [];
  const sharedIds = new Set(shared.map((l) => l.id));

  for (const l of shared) {
    const d = decisions[l.id]!;
    if (d === 'delete') {
      stmts.push(
        { sql: 'UPDATE lists SET deleted_at = ? WHERE id = ?', params: [now, l.id] },
        changeStmt(ctx, { entity: 'list', entityId: l.id, listId: l.id, op: 'delete', actor }),
      );
    } else {
      if (!l.members.some((m) => m.user_id === d.transfer_to)) {
        throw new HttpError(400, 'bad_transfer', 'The new owner must be a member of the list');
      }
      stmts.push(
        {
          sql: "UPDATE list_members SET role = 'editor' WHERE list_id = ? AND user_id = ?",
          params: [l.id, userId],
        },
        {
          sql: "UPDATE list_members SET role = 'owner' WHERE list_id = ? AND user_id = ?",
          params: [l.id, d.transfer_to],
        },
      );
    }
  }
  // Owned private lists: soft-deleted with the account (purged with it).
  const owned = await ctx.db.all<{ id: string }>(
    `SELECT l.id FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ? AND m.role = 'owner'
      WHERE l.deleted_at IS NULL`,
    userId,
  );
  for (const l of owned) {
    if (sharedIds.has(l.id)) continue;
    stmts.push({ sql: 'UPDATE lists SET deleted_at = ? WHERE id = ?', params: [now, l.id] });
  }
  // Leave every list that stays (others no longer see this person as a member).
  const memberships = await ctx.db.all<{ list_id: string }>(
    'SELECT list_id FROM list_members WHERE user_id = ?',
    userId,
  );
  for (const m of memberships) {
    const d = decisions[m.list_id];
    if (d === 'delete') continue;
    if (!d && owned.some((o) => o.id === m.list_id)) continue;
    stmts.push(
      changeStmt(ctx, {
        entity: 'member',
        entityId: userId,
        listId: m.list_id,
        op: 'delete',
        actor,
      }),
    );
  }
  stmts.push(
    {
      sql: `DELETE FROM list_members WHERE user_id = ? AND list_id IN
              (SELECT id FROM lists WHERE deleted_at IS NULL)`,
      params: [userId],
    },
    { sql: 'UPDATE users SET deleted_at = ? WHERE id = ?', params: [now, userId] },
    // Logged out everywhere, no more pushes, no pending links or nudges.
    { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [userId] },
    { sql: 'DELETE FROM push_subscriptions WHERE user_id = ?', params: [userId] },
    {
      sql: 'UPDATE device_links SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      params: [now, userId],
    },
    {
      sql: "UPDATE nudge_slots SET status = 'discarded' WHERE user_id = ? AND status = 'pending'",
      params: [userId],
    },
    { sql: 'DELETE FROM shared_queue WHERE recipient = ?', params: [userId] },
    { sql: 'DELETE FROM push_deferred WHERE user_id = ?', params: [userId] },
  );
  await ctx.db.batch(stmts);
}

/** Cron: hard-delete accounts whose grace period is over (everything cascades). */
export async function purgeDeletedAccounts(ctx: Ctx): Promise<number> {
  const cutoff = iso(ctx.clock.now() - ctx.config.DELETE_GRACE_DAYS * 86_400_000);
  const users = await ctx.db.all<{ id: string }>(
    'SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 50',
    cutoff,
  );
  for (const u of users) {
    await ctx.db.batch([
      // Lists the account still owned (soft-deleted above) go with it.
      {
        sql: `DELETE FROM lists WHERE id IN (SELECT list_id FROM list_members WHERE user_id = ? AND role = 'owner')`,
        params: [u.id],
      },
      { sql: 'DELETE FROM users WHERE id = ?', params: [u.id] },
    ]);
  }
  return users.length;
}
