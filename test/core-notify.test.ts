// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  allowedMinutes,
  drawNudges,
  isPaused,
  isQuiet,
  nextLocalTime,
  nextPeriodStart,
  quietEndsAt,
  seasonStartsOn,
} from '../src/core/notify';
import { seededRng } from '../src/core/suggest';
import { dateOf, minuteOfDay, zonedToEpoch } from '../src/core/time';

const OSLO = 'Europe/Oslo';
const at = (s: string) => Date.parse(s);

describe('time zones and DST', () => {
  it('shifts nonexistent spring-forward times one hour forward', () => {
    // 2027-03-28 02:30 does not exist in Oslo; it becomes 03:30 CEST = 01:30Z.
    expect(new Date(zonedToEpoch(2027, 3, 28, 2, 30, OSLO)).toISOString()).toBe(
      '2027-03-28T01:30:00.000Z',
    );
    // A repeated fall-back time resolves to its first occurrence (CEST).
    expect(new Date(zonedToEpoch(2026, 10, 25, 2, 30, OSLO)).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });
});

describe('quiet hours', () => {
  it('detects quiet hours that wrap midnight and finds their end', () => {
    expect(isQuiet(at('2026-10-15T21:30:00Z'), OSLO, '22:00', '08:00')).toBe(true); // 23:30
    expect(isQuiet(at('2026-10-15T10:00:00Z'), OSLO, '22:00', '08:00')).toBe(false);
    expect(
      new Date(quietEndsAt(at('2026-10-15T21:30:00Z'), OSLO, '22:00', '08:00')).toISOString(),
    ).toBe('2026-10-16T06:00:00.000Z');
    expect(isQuiet(at('2026-10-15T10:00:00Z'), OSLO, '00:00', '00:00')).toBe(false);
  });

  it('finds the next local 09:00', () => {
    expect(new Date(nextLocalTime(at('2026-10-15T05:00:00Z'), OSLO, '09:00')).toISOString()).toBe(
      '2026-10-15T07:00:00.000Z',
    );
    expect(new Date(nextLocalTime(at('2026-10-15T08:00:00Z'), OSLO, '09:00')).toISOString()).toBe(
      '2026-10-16T07:00:00.000Z',
    );
  });

  it('computes the next period start at local midnight', () => {
    // Thursday 2026-10-15 → Monday 2026-10-19 00:00 Oslo (CEST until the 25th).
    expect(new Date(nextPeriodStart(at('2026-10-15T10:00:00Z'), OSLO, 'week')).toISOString()).toBe(
      '2026-10-18T22:00:00.000Z',
    );
    expect(new Date(nextPeriodStart(at('2026-10-15T10:00:00Z'), OSLO, 'month')).toISOString()).toBe(
      '2026-10-31T23:00:00.000Z',
    );
  });
});

describe('nudge draw', () => {
  const base = {
    tz: OSLO,
    windowStart: '09:00',
    windowEnd: '21:00',
    quietStart: '22:00',
    quietEnd: '08:00',
  };

  it('draws distinct days in the allowed window at the start of a week', () => {
    const monday = zonedToEpoch(2026, 10, 19, 0, 0, OSLO);
    for (let seed = 1; seed < 50; seed++) {
      const d = drawNudges({
        ...base,
        now: monday,
        period: 'week',
        count: 3,
        rng: seededRng(seed),
      });
      expect(d.periodStart).toBe('2026-10-19');
      expect(d.slots).toHaveLength(3);
      const days = d.slots.map((s) => dateOf(s, OSLO));
      expect(new Set(days).size).toBe(3);
      for (const s of d.slots) {
        const m = minuteOfDay(s, OSLO);
        expect(m).toBeGreaterThanOrEqual(9 * 60);
        expect(m).toBeLessThan(21 * 60);
        expect(dateOf(s, OSLO) >= '2026-10-19' && dateOf(s, OSLO) <= '2026-10-25').toBe(true);
      }
    }
  });

  it('caps the count at one per day (a stored 31 in February sends 28)', () => {
    const feb1 = zonedToEpoch(2027, 2, 1, 0, 0, OSLO);
    const d = drawNudges({ ...base, now: feb1, period: 'month', count: 31, rng: seededRng(3) });
    expect(d.slots).toHaveLength(28);
    expect(new Set(d.slots.map((s) => dateOf(s, OSLO))).size).toBe(28);
  });

  it('scales the count mid-period and only uses today if time remains', () => {
    // Thursday 20:58 local: one allowed minute left today; 4 of 7 days remain.
    const thu = zonedToEpoch(2026, 10, 15, 20, 58, OSLO);
    const d = drawNudges({ ...base, now: thu, period: 'week', count: 7, rng: seededRng(9) });
    expect(d.slots).toHaveLength(4); // round(7 × 4 / 7)
    const late = zonedToEpoch(2026, 10, 15, 21, 30, OSLO);
    const d2 = drawNudges({ ...base, now: late, period: 'week', count: 7, rng: seededRng(9) });
    expect(d2.slots).toHaveLength(3);
    expect(d2.slots.every((s) => dateOf(s, OSLO) > '2026-10-15')).toBe(true);
  });

  it('clips the window to quiet hours; count 0 or no allowed time draws nothing', () => {
    expect(allowedMinutes('07:00', '10:00', '22:00', '08:00')).toHaveLength(120);
    const mon = zonedToEpoch(2026, 10, 19, 0, 0, OSLO);
    expect(
      drawNudges({ ...base, now: mon, period: 'week', count: 0, rng: seededRng(1) }).slots,
    ).toEqual([]);
    expect(
      drawNudges({
        ...base,
        windowStart: '23:00',
        windowEnd: '07:00',
        now: mon,
        period: 'week',
        count: 2,
        rng: seededRng(1),
      }).slots,
    ).toEqual([]);
  });

  it('handles DST weeks', () => {
    // The week of 2027-03-22 contains the spring-forward night.
    const mon = zonedToEpoch(2027, 3, 22, 0, 0, OSLO);
    const d = drawNudges({
      ...base,
      windowStart: '00:00',
      windowEnd: '23:59',
      quietStart: '00:00',
      quietEnd: '00:00',
      now: mon,
      period: 'week',
      count: 7,
      rng: seededRng(5),
    });
    expect(d.slots).toHaveLength(7);
    expect(new Set(d.slots.map((s) => dateOf(s, OSLO))).size).toBe(7);
  });
});

describe('helpers', () => {
  it('pauses until a time or forever', () => {
    expect(isPaused(at('2026-10-15T00:00:00Z'), null)).toBe(false);
    expect(isPaused(at('2026-10-15T00:00:00Z'), 'forever')).toBe(true);
    expect(isPaused(at('2026-10-15T00:00:00Z'), '2026-10-20T00:00:00.000Z')).toBe(true);
    expect(isPaused(at('2026-10-21T00:00:00Z'), '2026-10-20T00:00:00.000Z')).toBe(false);
  });

  it('detects the first day of a season', () => {
    const sepToMar = 0b111100000111;
    expect(seasonStartsOn(sepToMar, '2026-09-01')).toBe(true);
    expect(seasonStartsOn(sepToMar, '2026-10-01')).toBe(false);
    expect(seasonStartsOn(sepToMar, '2026-09-02')).toBe(false);
    expect(seasonStartsOn(0xfff, '2026-01-01')).toBe(false);
  });
});
