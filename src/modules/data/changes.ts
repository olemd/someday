// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The append-only change log (§3.4). Every write appends a row in the same
 * batch as the write itself, so sync (§6) and shared-list notifications see
 * exactly what was committed.
 */
import { iso, type Stmt } from '../../core/ports';
import type { Ctx } from '../types';

export type Entity = 'list' | 'item' | 'log' | 'member';

export interface Actor {
  /** User ID, or the OAuth client ID for MCP writes (§8.2). */
  id: string;
  kind: 'user' | 'oauth';
  /** For OAuth actors: the user the client acts for. */
  userId?: string;
}

export function changeStmt(
  ctx: Ctx,
  c: {
    entity: Entity;
    entityId: string;
    listId: string | null;
    op: 'upsert' | 'delete';
    actor: Actor | null;
    /** Restrict the row to one user's sync (private/anonymous log entries, lost access). */
    visibleTo?: string | null;
  },
  /** Only append when this SQL condition holds (e.g. the write it records happened). */
  gate?: { sql: string; params: (string | number | null)[] },
): Stmt {
  return {
    sql: `INSERT INTO changes (entity, entity_id, list_id, op, at, actor, actor_kind, visible_to, actor_user)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? ${gate ? `WHERE ${gate.sql}` : ''}`,
    params: [
      c.entity,
      c.entityId,
      c.listId,
      c.op,
      iso(ctx.clock.now()),
      c.actor?.id ?? null,
      c.actor?.kind ?? 'user',
      c.visibleTo ?? null,
      c.actor ? (c.actor.kind === 'user' ? c.actor.id : (c.actor.userId ?? null)) : null,
      ...(gate?.params ?? []),
    ],
  };
}
