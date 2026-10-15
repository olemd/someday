// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  daysUntilWindowEnd,
  eligible,
  inWindow,
  matchFilters,
  score,
  seasonEnd,
  seededRng,
  type SuggestContext,
  type SuggestItem,
  weightedSuggest,
} from '../src/core/suggest';
import { catalogs } from '../src/shared/i18n/catalogs.generated';
import { renderReasons } from '../src/shared/i18n/reasons';
import { createTranslator } from '../src/shared/i18n/translate';

const NOW = Date.UTC(2026, 9, 15, 10); // 2026-10-15
const TODAY = '2026-10-15';
const SEP_TO_MAR = 0b111100000111;

function item(over: Partial<SuggestItem> = {}): SuggestItem {
  return {
    id: over.id ?? 'a',
    list_id: 'L',
    title: 'x',
    status: 'idea',
    repeatable: false,
    duration: null,
    setting: null,
    cost: null,
    energy: null,
    social: null,
    valid_from: null,
    valid_to: null,
    months: null,
    tags: [],
    created_at: '2026-10-15T00:00:00.000Z',
    done_for_me: false,
    my_last_done_on: null,
    snoozed_until: null,
    last_suggested_at: null,
    ...over,
  };
}

const ctx = (items: SuggestItem[], over: Partial<SuggestContext> = {}): SuggestContext => ({
  items,
  now: NOW,
  today: TODAY,
  filters: {},
  rng: seededRng(1),
  ...over,
});

describe('windows and seasons', () => {
  it('finds the end of a season that wraps the year', () => {
    expect(seasonEnd(SEP_TO_MAR, '2026-10-15')).toBe('2027-03-31');
    expect(seasonEnd(SEP_TO_MAR, '2027-02-10')).toBe('2027-03-31');
    expect(seasonEnd(SEP_TO_MAR, '2026-06-01')).toBeNull(); // out of season
    expect(seasonEnd(0xfff, '2026-06-01')).toBeNull(); // all year
    expect(seasonEnd(1 << 9, '2026-10-02')).toBe('2026-10-31'); // October only
  });

  it('checks date windows and months', () => {
    expect(inWindow({ valid_from: null, valid_to: '2030-01-01', months: null }, TODAY)).toBe(true);
    expect(inWindow({ valid_from: '2026-10-16', valid_to: null, months: null }, TODAY)).toBe(false);
    expect(inWindow({ valid_from: null, valid_to: '2026-10-14', months: null }, TODAY)).toBe(false);
    expect(inWindow({ valid_from: null, valid_to: null, months: SEP_TO_MAR }, TODAY)).toBe(true);
    expect(inWindow({ valid_from: null, valid_to: null, months: 1 << 5 }, TODAY)).toBe(false);
  });

  it('reports the nearest window end', () => {
    expect(daysUntilWindowEnd({ valid_to: '2026-10-25', months: SEP_TO_MAR }, TODAY)).toEqual({
      days: 10,
      kind: 'date',
    });
    expect(daysUntilWindowEnd({ valid_to: null, months: 1 << 9 }, TODAY)).toEqual({
      days: 16,
      kind: 'season',
    });
  });
});

describe('eligibility', () => {
  it('excludes archived, done-for-me, snoozed, hidden, out-of-window and excluded items', () => {
    const c = ctx([]);
    expect(eligible(item({ status: 'archived' }), c)).toBeNull();
    expect(eligible(item({ status: 'done' }), c)).toBeNull();
    expect(eligible(item({ done_for_me: true }), c)).toBeNull();
    expect(eligible(item({ done_for_me: true, repeatable: true }), c)).toEqual([]);
    expect(eligible(item({ snoozed_until: '2026-10-20T00:00:00.000Z' }), c)).toBeNull();
    expect(eligible(item({ snoozed_until: '2026-10-01T00:00:00.000Z' }), c)).toEqual([]);
    expect(eligible(item({ hidden_at: '2026-10-01T00:00:00.000Z' }), c)).toBeNull();
    expect(eligible(item({ months: 1 }), c)).toBeNull();
    expect(eligible(item(), { ...c, exclude: ['a'] })).toBeNull();
  });

  it('applies filters; unset item fields match anything', () => {
    const f = {
      max_duration: 'half_day',
      setting: 'indoor',
      max_cost: 0,
      energy: 'low',
      social: 'solo',
    } as const;
    expect(matchFilters(item(), f)).toEqual([]);
    expect(matchFilters(item({ duration: 'short', setting: 'indoor', cost: 0 }), f)).toEqual([
      'duration_short',
      'setting_indoor',
      'cost_0',
    ]);
    expect(matchFilters(item({ duration: 'day' }), f)).toBeNull();
    expect(matchFilters(item({ setting: 'outdoor' }), f)).toBeNull();
    expect(matchFilters(item({ setting: 'either' }), f)).toEqual([]);
    expect(matchFilters(item({ cost: 1 }), f)).toBeNull();
    expect(matchFilters(item({ energy: 'high' }), f)).toBeNull();
    expect(matchFilters(item({ social: 'together' }), f)).toBeNull();
    expect(matchFilters(item({ tags: ['a'] }), { tags_include: ['A', 'b'] })).toEqual(['#a']);
    expect(matchFilters(item({ tags: ['c'] }), { tags_include: ['a'] })).toBeNull();
    expect(matchFilters(item({ tags: ['a'] }), { tags_exclude: ['a'] })).toBeNull();
    expect(matchFilters(item({ list_id: 'X' }), { list_ids: ['L'] })).toBeNull();
  });
});

describe('weights', () => {
  it('old ideas bubble up: 1 + log2(1 + days/30)', () => {
    const fresh = score(item(), [], { now: NOW, today: TODAY });
    const year = score(item({ created_at: '2025-10-15T00:00:00.000Z' }), [], {
      now: NOW,
      today: TODAY,
    });
    expect(fresh.score).toBe(1);
    expect(year.score).toBeCloseTo(1 + Math.log2(1 + 365 / 30));
    expect(year.reasons[0]).toEqual({ key: 'age_months', params: { count: 12 } });
  });

  it('multiplies closing window ×2, planned ×1.5, recent suggestion ×0.3, recent repeat ×0.5', () => {
    const t = { now: NOW, today: TODAY };
    expect(score(item({ valid_to: '2026-11-01' }), [], t).score).toBe(2);
    expect(score(item({ status: 'planned' }), [], t).score).toBe(1.5);
    expect(score(item({ last_suggested_at: '2026-10-12T00:00:00.000Z' }), [], t).score).toBeCloseTo(
      0.3,
    );
    const rep = score(item({ repeatable: true, my_last_done_on: '2026-10-05' }), [], t);
    expect(rep.score).toBeCloseTo((1 + Math.log2(1 + 10 / 30)) * 0.5);
    expect(rep.reasons[0]).toEqual({ key: 'last_done_days', params: { count: 10 } });
  });

  it('always explains itself in words', () => {
    const s = score(
      item({ created_at: '2025-08-01T00:00:00.000Z', months: 1 << 9, status: 'planned' }),
      ['setting_indoor', 'cost_0'],
      { now: NOW, today: TODAY },
    );
    const { t } = createTranslator('en', catalogs);
    expect(renderReasons(t, s.reasons)).toEqual([
      'On your list for 14 months',
      'Season ends in 2 weeks',
      'You planned this',
      'Matches: indoor, free',
    ]);
    expect(renderReasons(createTranslator('nb', catalogs).t, s.reasons)[3]).toBe(
      'Passer: innendørs, gratis',
    );
  });
});

describe('weighted pick', () => {
  it('is deterministic for a seed and roughly proportional to weight', () => {
    const items = [
      item({ id: 'heavy', status: 'planned', valid_to: '2026-10-20' }), // 3
      item({ id: 'light' }), // 1
    ];
    const counts = { heavy: 0, light: 0 };
    const rng = seededRng(42);
    for (let i = 0; i < 4000; i++)
      counts[weightedSuggest(ctx(items, { rng }))!.item.id as 'heavy']++;
    expect(counts.heavy / 4000).toBeGreaterThan(0.7);
    expect(counts.heavy / 4000).toBeLessThan(0.8);
    expect(weightedSuggest(ctx(items, { rng: seededRng(7) }))!.item.id).toBe(
      weightedSuggest(ctx(items, { rng: seededRng(7) }))!.item.id,
    );
  });

  it('returns null when nothing is eligible', () => {
    expect(weightedSuggest(ctx([item({ status: 'archived' })]))).toBeNull();
  });
});
