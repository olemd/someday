// SPDX-License-Identifier: AGPL-3.0-or-later
/** Access and actor for a cookie-authenticated request (all the user's lists). */
import type { Context } from 'hono';
import { sessionOf } from './auth/middleware';
import type { Actor } from './data/changes';
import type { Access } from './lists/access';
import type { AppEnv } from './types';

export function sessionAccess(c: Context<AppEnv>): { access: Access; actor: Actor } {
  const userId = sessionOf(c).userId;
  return { access: { userId, listIds: null }, actor: { id: userId, kind: 'user' } };
}
