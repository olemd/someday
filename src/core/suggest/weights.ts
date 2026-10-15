// SPDX-License-Identifier: AGPL-3.0-or-later
/** Every tunable of the weighted suggester (§4.1), in one place. */
export const WEIGHTS = {
  base: 1.0,
  /** Age bonus: 1 + log2(1 + days / ageDays). */
  ageDays: 30,
  /** A window (date or season) ending within this many days doubles the weight. */
  closingWindowDays: 30,
  closingWindow: 2,
  planned: 1.5,
  /** Suggested to this user within this many days: damped. */
  recentlySuggestedDays: 7,
  recentlySuggested: 0.3,
  /** Repeatable and done within this many days: damped. */
  recentlyDoneDays: 30,
  recentlyDone: 0.5,
} as const;
