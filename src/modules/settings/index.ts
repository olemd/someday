// SPDX-License-Identifier: AGPL-3.0-or-later
/** Per-user settings (GET returns defaults merged with overrides; PATCH validates). */
import { createRoute } from '@hono/zod-openapi';
import { type Settings, SettingsSchema } from '../../core/settings';
import { sessionOf } from '../auth/middleware';
import { body, json } from '../http';
import { userSettings } from '../notices/service';
import type { Ctx, Module, Router } from '../types';

/** Hooks run after settings change (e.g. the nudge schedule redraws, §5.1). */
const listeners: ((ctx: Ctx, userId: string, changed: (keyof Settings)[]) => Promise<void>)[] = [];
export function onSettingsChanged(l: (typeof listeners)[number]) {
  listeners.push(l);
}

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['settings'],
      responses: { 200: json(SettingsSchema) },
    }),
    async (c) => c.json(await userSettings(c.env.ctx, sessionOf(c).userId), 200),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/',
      tags: ['settings'],
      request: body(SettingsSchema.partial()),
      responses: { 200: json(SettingsSchema) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const userId = sessionOf(c).userId;
      const patch = c.req.valid('json');
      const keys = Object.keys(patch) as (keyof Settings)[];
      await ctx.db.batch(
        keys.map((k) => ({
          sql: `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
                ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
          params: [userId, k, JSON.stringify(patch[k])],
        })),
      );
      for (const l of listeners) await l(ctx, userId, keys);
      return c.json(await userSettings(ctx, userId), 200);
    },
  );
}

export const settingsModule: Module = { name: 'settings', routes };
