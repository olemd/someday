// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Running the suggester (§4) for a user: gather the candidate items, resolve
 * the default lists, pick, remember "last suggested", render reasons. Used by
 * the API, nudges (§5.1) and the MCP `suggest` tool (§8.2).
 */
import type { SuggestFilters, Suggester, Suggestion } from '../../core/suggest';
import { cryptoRng, eligible, weightedSuggester } from '../../core/suggest';
import { iso } from '../../core/ports';
import { dateOf } from '../../core/time';
import type { Item } from '../../shared/schemas/items';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { renderReasons } from '../../shared/i18n/reasons';
import { createTranslator } from '../../shared/i18n/translate';
import { setSuggestionState, queryItems } from '../items/service';
import type { Access } from '../lists/access';
import { userSettings } from '../notices/service';
import type { Ctx } from '../types';

/** SUGGESTER=llm is reserved for later (§4.2); v1 always uses the weighted one. */
export function suggesterFor(_ctx: Ctx): Suggester {
  return weightedSuggester;
}

export interface SuggestResult {
  suggestion: (Suggestion<Item> & { reason_texts: string[] }) | null;
  /** How many items were eligible (for "nothing fits" vs "try another"). */
  eligible: number;
}

/** Lists included by default: memberships with "include in suggestions" on (§4.1). */
async function defaultListIds(ctx: Ctx, access: Access): Promise<string[]> {
  const rows = await ctx.db.all<{ list_id: string }>(
    `SELECT m.list_id FROM list_members m JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL
      WHERE m.user_id = ? AND m.include_in_suggestions = 1`,
    access.userId,
  );
  const ids = rows.map((r) => r.list_id);
  return access.listIds ? ids.filter((id) => access.listIds!.includes(id)) : ids;
}

export async function suggestFor(
  ctx: Ctx,
  access: Access,
  filters: SuggestFilters,
  opts: { exclude?: string[]; remember?: boolean; rng?: () => number } = {},
): Promise<SuggestResult> {
  const settings = await userSettings(ctx, access.userId);
  const listIds = filters.list_ids?.length
    ? filters.list_ids.filter((id) => !access.listIds || access.listIds.includes(id))
    : await defaultListIds(ctx, access);
  const items = await queryItems(ctx, access, {
    status: ['idea', 'planned'],
    open_for_me: true,
  });
  const now = ctx.clock.now();
  const base = {
    items,
    now,
    today: dateOf(now, settings.timezone),
    filters: { ...filters, list_ids: listIds },
    exclude: opts.exclude ?? [],
    rng: opts.rng ?? cryptoRng,
  };
  const count = items.filter((i) => eligible(i, base) !== null).length;
  const pick = await suggesterFor(ctx).suggest(base);
  if (!pick) return { suggestion: null, eligible: 0 };
  if (opts.remember !== false) {
    await setSuggestionState(ctx, access, pick.item.id, { last_suggested_at: iso(now) });
  }
  const { t } = createTranslator(settings.locale, catalogs);
  return {
    suggestion: { ...pick, reason_texts: renderReasons(t, pick.reasons) },
    eligible: count,
  };
}
