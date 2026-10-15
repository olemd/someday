// SPDX-License-Identifier: AGPL-3.0-or-later
/** Renders suggester reasons (§4.1) as text, on the server (API, push) and in the PWA. */
import type { Reason } from '../../core/suggest';
import type { TFunction } from './translate';

/** "duration_short", "cost_0", "#nature" → localised words. */
function matchLabel(t: TFunction, label: string): string {
  return label.startsWith('#') ? label : t(`reason.match.${label}`);
}

export function renderReason(t: TFunction, r: Reason): string {
  if (r.key === 'matches') {
    const list = String(r.params?.list ?? '')
      .split(',')
      .filter(Boolean)
      .map((l) => matchLabel(t, l));
    return t('reason.matches', { list: list.join(', ') });
  }
  return t(`reason.${r.key}`, r.params);
}

export function renderReasons(t: TFunction, reasons: Reason[]): string[] {
  return reasons.map((r) => renderReason(t, r));
}
