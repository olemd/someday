// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Give me something" (§4). Callers depend on the `Suggester` interface so an
 * LLM implementation can be added later (§4.2) without touching them.
 *
 * `weightedSuggest` is a pure function over the item list, the clock and an
 * RNG: fully unit-testable, and also usable in the browser while offline.
 */
import { WEIGHTS } from './weights';

export const DURATION_ORDER = ['short', 'half_day', 'day', 'weekend', 'trip'] as const;
export const ENERGY_ORDER = ['low', 'medium', 'high'] as const;

/** The fields the suggester reads (a subset of the API's Item). */
export interface SuggestItem {
  id: string;
  list_id: string;
  title: string;
  status: 'idea' | 'planned' | 'done' | 'archived';
  repeatable: boolean;
  duration: (typeof DURATION_ORDER)[number] | null;
  setting: 'indoor' | 'outdoor' | 'either' | null;
  cost: number | null;
  energy: (typeof ENERGY_ORDER)[number] | null;
  social: 'solo' | 'together' | 'either' | null;
  valid_from: string | null;
  valid_to: string | null;
  months: number | null;
  tags: string[];
  created_at: string;
  done_for_me: boolean;
  my_last_done_on: string | null;
  snoozed_until: string | null;
  last_suggested_at: string | null;
}

export interface SuggestFilters {
  /** Available time: the longest acceptable duration. */
  max_duration?: (typeof DURATION_ORDER)[number];
  setting?: 'indoor' | 'outdoor';
  max_cost?: number;
  /** Energy available: items needing more are excluded. */
  energy?: (typeof ENERGY_ORDER)[number];
  social?: 'solo' | 'together';
  /** Lists to include; the caller resolves the default (all included memberships). */
  list_ids?: string[];
  tags_include?: string[];
  tags_exclude?: string[];
}

export interface SuggestContext {
  items: SuggestItem[];
  /** Epoch ms. */
  now: number;
  /** Today in the user's time zone, 'YYYY-MM-DD'. */
  today: string;
  filters: SuggestFilters;
  /** Already shown this session ("Another one"). */
  exclude?: string[];
  /** Uniform [0, 1). */
  rng: () => number;
}

/** A reason as a translation key plus parameters; the UI/API render it. */
export interface Reason {
  key: string;
  params?: Record<string, string | number>;
}

export interface Suggestion<T extends SuggestItem = SuggestItem> {
  item: T;
  score: number;
  reasons: Reason[];
}

export interface Suggester {
  suggest<T extends SuggestItem>(
    ctx: SuggestContext & { items: T[] },
  ): Promise<Suggestion<T> | null>;
}

// ── Calendar helpers (pure, UTC arithmetic on 'YYYY-MM-DD') ─────────────

const DAY = 86_400_000;
const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const daysBetween = (from: string, to: string) => Math.round((dateMs(to) - dateMs(from)) / DAY);
const monthOf = (d: string) => Number(d.slice(5, 7)); // 1-12
const monthBit = (m: number) => 1 << (m - 1);

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * The last day of the seasonal run containing `today` (e.g. Sep–Mar wraps
 * the year), or null if the item is allowed all year.
 */
export function seasonEnd(months: number, today: string): string | null {
  if ((months & 0xfff) === 0xfff) return null;
  let year = Number(today.slice(0, 4));
  let m = monthOf(today);
  if (!(months & monthBit(m))) return null;
  for (let i = 0; i < 12; i++) {
    const nextM = m === 12 ? 1 : m + 1;
    if (!(months & monthBit(nextM))) return lastDayOfMonth(year, m);
    if (m === 12) year++;
    m = nextM;
  }
  return null;
}

/** Whether `today` falls inside the item's date window and season (§4.1 rule 3). */
export function inWindow(
  item: Pick<SuggestItem, 'valid_from' | 'valid_to' | 'months'>,
  today: string,
) {
  if (item.valid_from && today < item.valid_from) return false;
  if (item.valid_to && today > item.valid_to) return false;
  if (item.months && !(item.months & monthBit(monthOf(today)))) return false;
  return true;
}

/** Days until the nearest end of the item's window (date or season), or null. */
export function daysUntilWindowEnd(
  item: Pick<SuggestItem, 'valid_to' | 'months'>,
  today: string,
): { days: number; kind: 'date' | 'season' } | null {
  const ends: { days: number; kind: 'date' | 'season' }[] = [];
  if (item.valid_to) ends.push({ days: daysBetween(today, item.valid_to), kind: 'date' });
  if (item.months) {
    const end = seasonEnd(item.months, today);
    if (end) ends.push({ days: daysBetween(today, end), kind: 'season' });
  }
  ends.sort((a, b) => a.days - b.days);
  return ends[0] ?? null;
}

// ── Filters ────────────────────────────────────────────────────────────

/** Unset item fields match any filter (§3.2). Returns the matched labels for the reasons. */
export function matchFilters(item: SuggestItem, f: SuggestFilters): string[] | null {
  const matched: string[] = [];
  if (f.list_ids && !f.list_ids.includes(item.list_id)) return null;
  if (f.max_duration && item.duration) {
    if (DURATION_ORDER.indexOf(item.duration) > DURATION_ORDER.indexOf(f.max_duration)) return null;
    matched.push(`duration_${item.duration}`);
  }
  if (f.setting && item.setting && item.setting !== 'either') {
    if (item.setting !== f.setting) return null;
    matched.push(`setting_${item.setting}`);
  }
  if (f.max_cost !== undefined && item.cost !== null) {
    if (item.cost > f.max_cost) return null;
    matched.push(`cost_${item.cost}`);
  }
  if (f.energy && item.energy) {
    if (ENERGY_ORDER.indexOf(item.energy) > ENERGY_ORDER.indexOf(f.energy)) return null;
    matched.push(`energy_${item.energy}`);
  }
  if (f.social && item.social && item.social !== 'either') {
    if (item.social !== f.social) return null;
    matched.push(`social_${item.social}`);
  }
  const tags = new Set(item.tags.map((t) => t.toLowerCase()));
  if (f.tags_include?.length) {
    const hit = f.tags_include.filter((t) => tags.has(t.toLowerCase()));
    if (!hit.length) return null;
    matched.push(...hit.map((t) => `#${t.toLowerCase()}`));
  }
  if (f.tags_exclude?.some((t) => tags.has(t.toLowerCase()))) return null;
  return matched;
}

/** Eligibility (§4.1 rules 1–4); returns matched filter labels, or null. */
export function eligible(item: SuggestItem, ctx: SuggestContext): string[] | null {
  if (item.status !== 'idea' && item.status !== 'planned') return null;
  if (!item.repeatable && item.done_for_me) return null;
  if (item.snoozed_until && Date.parse(item.snoozed_until) > ctx.now) return null;
  if (!inWindow(item, ctx.today)) return null;
  if (ctx.exclude?.includes(item.id)) return null;
  return matchFilters(item, ctx.filters);
}

/** Age as the largest sensible unit: 14 months, 3 weeks, 5 days. */
export function ageReason(days: number): Reason {
  if (days >= 730) return { key: 'age_years', params: { count: Math.floor(days / 365) } };
  if (days >= 60) return { key: 'age_months', params: { count: Math.round(days / 30.4375) } };
  if (days >= 14) return { key: 'age_weeks', params: { count: Math.floor(days / 7) } };
  if (days >= 1) return { key: 'age_days', params: { count: days } };
  return { key: 'age_new' };
}

function humanDays(days: number): { count: number; unit: 'days' | 'weeks' | 'months' } {
  if (days >= 60) return { count: Math.round(days / 30.44), unit: 'months' };
  if (days >= 14) return { count: Math.round(days / 7), unit: 'weeks' };
  return { count: days, unit: 'days' };
}

/** The weight of an eligible item and the reasons behind it (§4.1). */
export function score(
  item: SuggestItem,
  matched: string[],
  ctx: Pick<SuggestContext, 'now' | 'today'>,
): { score: number; reasons: Reason[] } {
  const reasons: Reason[] = [];
  let w: number = WEIGHTS.base;

  // Age: since created, or since last done (repeatable items come round again).
  const since = item.my_last_done_on ?? item.created_at.slice(0, 10);
  const age = Math.max(0, daysBetween(since, ctx.today));
  w *= 1 + Math.log2(1 + age / WEIGHTS.ageDays);
  if (item.my_last_done_on) {
    const h = humanDays(age);
    reasons.push({ key: `last_done_${h.unit}`, params: { count: h.count } });
  } else reasons.push(ageReason(age));

  const end = daysUntilWindowEnd(item, ctx.today);
  if (end && end.days <= WEIGHTS.closingWindowDays) {
    w *= WEIGHTS.closingWindow;
    const h = humanDays(end.days);
    reasons.push({
      key: end.days === 0 ? `${end.kind}_ends_today` : `${end.kind}_ends_${h.unit}`,
      params: { count: h.count },
    });
  }

  if (item.status === 'planned') {
    w *= WEIGHTS.planned;
    reasons.push({ key: 'planned' });
  }

  if (
    item.last_suggested_at &&
    ctx.now - Date.parse(item.last_suggested_at) < WEIGHTS.recentlySuggestedDays * DAY
  ) {
    w *= WEIGHTS.recentlySuggested;
  }

  if (item.repeatable && item.my_last_done_on && age < WEIGHTS.recentlyDoneDays) {
    w *= WEIGHTS.recentlyDone;
  }

  if (matched.length) reasons.push({ key: 'matches', params: { list: matched.join(',') } });
  return { score: w, reasons };
}

/** Weighted random pick among eligible items (§4.1). */
export function weightedSuggest<T extends SuggestItem>(
  ctx: SuggestContext & { items: T[] },
): Suggestion<T> | null {
  const scored: Suggestion<T>[] = [];
  for (const item of ctx.items) {
    const matched = eligible(item, ctx);
    if (matched === null) continue;
    const s = score(item, matched, ctx);
    scored.push({ item, score: s.score, reasons: s.reasons });
  }
  if (!scored.length) return null;
  const total = scored.reduce((n, s) => n + s.score, 0);
  let r = ctx.rng() * total;
  for (const s of scored) {
    r -= s.score;
    if (r < 0) return s;
  }
  return scored[scored.length - 1]!;
}

export const weightedSuggester: Suggester = {
  async suggest(ctx) {
    return weightedSuggest(ctx);
  },
};

/** Deterministic RNG for tests and reproducible picks (mulberry32). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Uniform [0, 1) from crypto.getRandomValues. */
export function cryptoRng(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4_294_967_296;
}
