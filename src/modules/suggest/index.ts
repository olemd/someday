// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * POST /api/suggest — "give me something" (§4), and the suggestion actions
 * that are not plain item updates: "Not now" (snooze) and its undo.
 * "Let's do it" and "Never" are status changes; "Done" is the log.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { SuggestFiltersSchema } from '../../core/settings';
import { iso } from '../../core/ports';
import { sessionAccess } from '../access';
import { body, json } from '../http';
import { setSuggestionState } from '../items/service';
import { userSettings } from '../notices/service';
import type { Module, Router } from '../types';
import { suggestFor } from './service';

const Any = z.record(z.string(), z.unknown());
const Ok = z.object({ ok: z.literal(true) });

function routes(app: Router) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['suggest'],
      request: body(
        z.object({
          filters: SuggestFiltersSchema.default({}),
          /** Items already shown in this session ("Another one"). */
          exclude: z.array(z.string()).max(500).default([]),
        }),
      ),
      responses: { 200: json(z.object({ suggestion: Any.nullable(), eligible: z.number() })) },
    }),
    async (c) => {
      const { filters, exclude } = c.req.valid('json');
      return c.json(
        await suggestFor(c.env.ctx, sessionAccess(c).access, filters, { exclude }),
        200,
      );
    },
  );
}

function snoozeRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/snooze',
      tags: ['suggest'],
      request: {
        params: z.object({ id: z.string() }),
        ...body(
          z.object({
            days: z.number().int().min(1).max(3650).optional(),
            until: z.iso.datetime().optional(),
          }),
        ),
      },
      responses: { 200: json(z.object({ snoozed_until: z.string() })) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const { access } = sessionAccess(c);
      const { days, until } = c.req.valid('json');
      const settings = await userSettings(ctx, access.userId);
      const snoozedUntil =
        until ?? iso(ctx.clock.now() + (days ?? settings.snooze_days) * 86_400_000);
      await setSuggestionState(ctx, access, c.req.valid('param').id, {
        snoozed_until: snoozedUntil,
      });
      return c.json({ snoozed_until: snoozedUntil }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}/snooze',
      tags: ['suggest'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      await setSuggestionState(c.env.ctx, sessionAccess(c).access, c.req.valid('param').id, {
        snoozed_until: null,
      });
      return c.json({ ok: true as const }, 200);
    },
  );
}

export const suggestModule: Module = { name: 'suggest', routes };
/** Snooze lives under /api/items/{id}/snooze, next to the item. */
export const snoozeModule: Module = {
  name: 'snooze',
  mountPath: '/api/items',
  routes: snoozeRoutes,
};
