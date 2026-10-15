// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Time-zone arithmetic with Intl only (no tz database in the bundle).
 * Adapted from stoppeklokke's core/time/tz.ts, in epoch milliseconds.
 *
 * Calendar dates are 'YYYY-MM-DD' strings interpreted in an explicit IANA
 * zone — never the runtime's zone. Intl.DateTimeFormat construction is the
 * expensive part, so formatters are cached per zone.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(ms)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday!] ?? 1,
  };
}

/** Offset of `tz` from UTC at `ms`, in milliseconds (e.g. +7 200 000 for Oslo in summer). */
export function tzOffset(ms: number, tz: string): number {
  const s = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(s, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
}

/**
 * Epoch ms for a wall-clock time in `tz`. Times skipped by a DST jump are
 * shifted forward by the size of the jump (02:30 on a spring-forward night
 * becomes 03:30, §5.1); for repeated times the first occurrence wins.
 */
export function zonedToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const before = tzOffset(naive - 86_400_000, tz);
  const after = tzOffset(naive + 86_400_000, tz);
  const a = naive - before;
  const b = naive - after;
  const matches = (e: number) => {
    const p = zonedParts(e, tz);
    return p.hour === hour && p.minute === minute && p.day === day;
  };
  const candidates = [a, b].filter(matches).sort((x, y) => x - y);
  if (candidates.length) return candidates[0]!;
  // Nonexistent local time (spring forward): use the pre-transition offset,
  // which lands the same distance after the jump.
  return a;
}

export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid date: ${date}`);
  }
  return { year, month, day };
}

export function isValidDate(date: string): boolean {
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatDateParts(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Calendar date of `ms` in `tz`. */
export function dateOf(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return formatDateParts(p.year, p.month, p.day);
}

/** Pure calendar arithmetic on 'YYYY-MM-DD' (no time zone involved). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) /
      86_400_000,
  );
}

/** ISO weekday (1 = Monday) of a calendar date. */
export function weekdayOf(date: string): number {
  const { year, month, day } = parseDate(date);
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Monday of the ISO week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, 1 - weekdayOf(date));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function daysInMonth(date: string): number {
  const { year, month } = parseDate(date);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Epoch ms of 00:00 on `date` in `tz`. */
export function startOfDay(date: string, tz: string): number {
  const { year, month, day } = parseDate(date);
  return zonedToEpoch(year, month, day, 0, 0, tz);
}

let zoneSet: Set<string> | null = null;

/** Validates an IANA zone against Intl.supportedValuesOf('timeZone'). */
export function isValidTimeZone(tz: string): boolean {
  if (tz === 'UTC') return true;
  zoneSet ??= new Set(Intl.supportedValuesOf('timeZone'));
  return zoneSet.has(tz);
}

/** 'HH:MM' → minutes after midnight, or null. */
export function parseHM(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const formatHM = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** Minutes after local midnight of `ms` in `tz`. */
export function minuteOfDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return p.hour * 60 + p.minute;
}

/**
 * Whether local minute-of-day `m` falls in the window [start, end). A window
 * whose end is before its start wraps midnight (22:00–08:00). start == end
 * means an empty window.
 */
export function inWindow(m: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? m >= start && m < end : m >= start || m < end;
}
