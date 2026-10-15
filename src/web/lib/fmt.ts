// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Display helpers. Always 24-hour clock (§ intro), the user's stored time
 * zone (not the browser's), and the UI language. ISO 8601 stays for
 * exports and the API.
 */
import { translator } from './i18n';
import { settings } from './store';

const cache = new Map<string, Intl.DateTimeFormat>();

/** Generic `en` gives US-style dates; the UI uses day-month order, as en-GB. */
const dateLocale = (l: string) => (l === 'en' ? 'en-GB' : l);

function fmt(kind: string, opts: Intl.DateTimeFormatOptions, utc = false) {
  const locale = dateLocale(translator.value.locale);
  const tz = utc ? 'UTC' : (settings.value?.timezone ?? 'UTC');
  const key = `${kind}|${locale}|${tz}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, hourCycle: 'h23', ...opts });
    cache.set(key, f);
  }
  return f;
}

/** "09:22" */
export const time = (isoString: string) =>
  fmt('time', { hour: '2-digit', minute: '2-digit' }).format(new Date(isoString));

/** "15 Oct 2026, 09:22" */
export const dateTime = (isoString: string) =>
  fmt('dt', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoString));

/** A calendar date 'YYYY-MM-DD' without any zone shift: "15 Oct 2026". */
export const calendarDate = (date: string) =>
  fmt('cal', { day: 'numeric', month: 'short', year: 'numeric' }, true).format(
    new Date(`${date}T12:00:00Z`),
  );

/** Localised month name (1-12), short. */
export const monthName = (m: number) =>
  fmt('month', { month: 'short' }, true).format(new Date(Date.UTC(2026, m - 1, 15)));

/** Today's date in the user's time zone, 'YYYY-MM-DD'. */
export function today(): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.value?.timezone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return p;
}
