// SPDX-License-Identifier: AGPL-3.0-or-later
/** Localised labels for item fields (enums, months). */
import type { Item } from '../../shared/schemas/items';
import { monthName } from './fmt';
import { t } from './i18n';

export const DURATIONS = ['short', 'half_day', 'day', 'weekend', 'trip'] as const;
export const SETTINGS = ['indoor', 'outdoor', 'either'] as const;
export const ENERGIES = ['low', 'medium', 'high'] as const;
export const SOCIALS = ['solo', 'together', 'either'] as const;
export const COSTS = [0, 1, 2, 3] as const;
export const STATUSES = ['idea', 'planned', 'done', 'archived'] as const;

export const statusLabel = (s: Item['status']) => t(`status.${s}`);
export const durationLabel = (d: NonNullable<Item['duration']>) => t(`duration.${d}`);
export const settingLabel = (s: NonNullable<Item['setting']>) => t(`setting.${s}`);
export const energyLabel = (e: NonNullable<Item['energy']>) => t(`energy.${e}`);
export const socialLabel = (s: NonNullable<Item['social']>) => t(`social.${s}`);
export const costLabel = (c: number) => t(`cost.${c}`);

/** "Sep–Mar", "Jun, Aug" from a month bitmask (runs wrap the year). */
export function monthsLabel(mask: number | null): string {
  if (!mask || (mask & 0xfff) === 0xfff) return '';
  const on = (m: number) => !!(mask & (1 << (m - 1)));
  // Start at a month whose predecessor is off, so a wrapping run reads Sep–Mar.
  let start = 1;
  for (let m = 1; m <= 12; m++) {
    if (on(m) && !on(m === 1 ? 12 : m - 1)) {
      start = m;
      break;
    }
  }
  const runs: string[] = [];
  let i = 0;
  while (i < 12) {
    const m = ((start - 1 + i) % 12) + 1;
    if (!on(m)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < 12 && on(((start - 1 + j + 1) % 12) + 1)) j++;
    const end = ((start - 1 + j) % 12) + 1;
    runs.push(m === end ? monthName(m) : `${monthName(m)}–${monthName(end)}`);
    i = j + 1;
  }
  return runs.join(', ');
}

/** Short context summary for list rows: "Half a day · Outdoor · Free · Sep–Mar". */
export function contextSummary(i: Item): string[] {
  const out: string[] = [];
  if (i.duration) out.push(durationLabel(i.duration));
  if (i.setting && i.setting !== 'either') out.push(settingLabel(i.setting));
  if (i.cost !== null) out.push(costLabel(i.cost));
  if (i.energy) out.push(energyLabel(i.energy));
  if (i.social && i.social !== 'either') out.push(socialLabel(i.social));
  const months = monthsLabel(i.months);
  if (months) out.push(months);
  return out;
}
