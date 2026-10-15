// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notification timing (§5), pure and time-zone aware: quiet hours, "next
 * 09:00 local", nudge periods and the random nudge draw (§5.1).
 */
import {
  addDays,
  dateOf,
  daysInMonth,
  inWindow,
  minuteOfDay,
  parseDate,
  parseHM,
  startOfMonth,
  startOfWeek,
  zonedToEpoch,
} from './time';

const MIN = 60_000;

/** Whether `ms` falls in the user's quiet hours (local time, may wrap midnight). */
export function isQuiet(ms: number, tz: string, quietStart: string, quietEnd: string): boolean {
  return inWindow(minuteOfDay(ms, tz), parseHM(quietStart)!, parseHM(quietEnd)!);
}

/** Epoch ms of the next local wall-clock time `hm` strictly after `ms`. */
export function nextLocalTime(ms: number, tz: string, hm: string): number {
  const m = parseHM(hm)!;
  let date = dateOf(ms, tz);
  for (let i = 0; i < 3; i++) {
    const { year, month, day } = parseDate(date);
    const at = zonedToEpoch(year, month, day, Math.floor(m / 60), m % 60, tz);
    if (at > ms) return at;
    date = addDays(date, 1);
  }
  throw new Error('nextLocalTime: no time found');
}

/** When the current quiet period ends (or `ms` itself when not quiet). */
export function quietEndsAt(ms: number, tz: string, quietStart: string, quietEnd: string): number {
  if (!isQuiet(ms, tz, quietStart, quietEnd)) return ms;
  return nextLocalTime(ms, tz, quietEnd);
}

export type Period = 'week' | 'month';

/** First day of the nudge period containing `date` (Monday, or the 1st). */
export function periodStart(date: string, period: Period): string {
  return period === 'week' ? startOfWeek(date) : startOfMonth(date);
}

export function periodDays(start: string, period: Period): string[] {
  const n = period === 'week' ? 7 : daysInMonth(start);
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}

/** Epoch ms when the period after the one containing `ms` starts (local midnight). */
export function nextPeriodStart(ms: number, tz: string, period: Period): number {
  const start = periodStart(dateOf(ms, tz), period);
  const next = period === 'week' ? addDays(start, 7) : addDays(start, daysInMonth(start));
  const { year, month, day } = parseDate(next);
  return zonedToEpoch(year, month, day, 0, 0, tz);
}

/**
 * Minutes of the day (0–1439) a nudge may be sent: inside the allowed
 * window and outside quiet hours (§5.1 "always clipped to quiet hours").
 */
export function allowedMinutes(
  windowStart: string,
  windowEnd: string,
  quietStart: string,
  quietEnd: string,
): number[] {
  const ws = parseHM(windowStart)!;
  const we = parseHM(windowEnd)!;
  const qs = parseHM(quietStart)!;
  const qe = parseHM(quietEnd)!;
  const out: number[] = [];
  for (let m = 0; m < 1440; m++) if (inWindow(m, ws, we) && !inWindow(m, qs, qe)) out.push(m);
  return out;
}

export interface DrawInput {
  now: number;
  tz: string;
  period: Period;
  count: number;
  windowStart: string;
  windowEnd: string;
  quietStart: string;
  quietEnd: string;
  /** Uniform [0, 1); production passes a crypto.getRandomValues source. */
  rng: () => number;
}

export interface Draw {
  periodStart: string;
  slots: number[];
}

/**
 * Draw this period's nudge times (§5.1): `count` (capped at one per day)
 * distinct days uniformly from the days still ahead, each with a uniformly
 * random minute in the allowed window. Mid-period (enabling or changing
 * settings) the count is scaled: round(count × remaining_days / period_days).
 * Today counts only if an allowed minute is still ahead. Local times are
 * converted per slot, so DST is handled; nonexistent times move forward.
 */
export function drawNudges(input: DrawInput): Draw {
  const today = dateOf(input.now, input.tz);
  const start = periodStart(today, input.period);
  const days = periodDays(start, input.period);
  const capped = Math.min(Math.max(0, input.count), days.length);
  const allowed = allowedMinutes(
    input.windowStart,
    input.windowEnd,
    input.quietStart,
    input.quietEnd,
  );
  if (!allowed.length || capped === 0) return { periodStart: start, slots: [] };

  const nowMinute = minuteOfDay(input.now, input.tz);
  const minutesFor = (d: string) => (d === today ? allowed.filter((m) => m > nowMinute) : allowed);
  const remaining = days.filter((d) => d >= today && minutesFor(d).length > 0);
  // At the very start of a period every day remains, so this is just `capped`.
  const target = Math.min(
    remaining.length,
    remaining.length === days.length
      ? capped
      : Math.round((capped * remaining.length) / days.length),
  );

  // Partial Fisher–Yates: `target` distinct days, uniformly.
  const pool = [...remaining];
  const chosen: string[] = [];
  for (let i = 0; i < target; i++) {
    const j = i + Math.floor(input.rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    chosen.push(pool[i]!);
  }

  const slots = chosen
    .map((d) => {
      const mins = minutesFor(d);
      const m = mins[Math.floor(input.rng() * mins.length)]!;
      const { year, month, day } = parseDate(d);
      return zonedToEpoch(year, month, day, Math.floor(m / 60), m % 60, input.tz);
    })
    .filter((at) => at > input.now - MIN)
    .sort((a, b) => a - b);
  return { periodStart: start, slots };
}

/** Whether a nudge at `at` falls inside a pause ('forever' or until an ISO time). */
export function isPaused(at: number, pausedUntil: string | null): boolean {
  if (!pausedUntil) return false;
  return pausedUntil === 'forever' || at < Date.parse(pausedUntil);
}

/** Whether a season (month bitmask) starts on `date` (the 1st of its first month). */
export function seasonStartsOn(months: number | null, date: string): boolean {
  if (!months || (months & 0xfff) === 0xfff) return false;
  const { month, day } = parseDate(date);
  if (day !== 1) return false;
  const bit = (m: number) => 1 << (m - 1);
  const prev = month === 1 ? 12 : month - 1;
  return !!(months & bit(month)) && !(months & bit(prev));
}
