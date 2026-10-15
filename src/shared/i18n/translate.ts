// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tiny translator shared by the web app and the Worker (§7.5).
 *
 * - `{name}` interpolation.
 * - Plurals via Intl.PluralRules and suffixed keys: `hours_one`, `hours_other`,
 *   plus whatever categories the language needs (`_few`, `_many`, ...).
 * - Fallback chain: exact locale (nb-NO) → language (nb) → en. Missing keys
 *   fall back to English.
 *
 * No ICU MessageFormat library on purpose: bundle size matters for the PWA and
 * the Worker.
 */

export interface LocaleMeta {
  name: string;
  englishName: string;
  dir: 'ltr' | 'rtl';
}

export type Catalog = { _meta: LocaleMeta } & Record<string, unknown>;
export type Catalogs = Record<string, Catalog>;

export type Params = Record<string, string | number>;
export type TFunction = (key: string, params?: Params) => string;

export const SOURCE_LOCALE = 'en';

/** Flatten nested JSON into dotted keys: {timer: {start: "x"}} → {"timer.start": "x"}. */
export function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_meta') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key, out);
  }
  return out;
}

/** Resolve a requested locale tag to the best available catalog key. */
export function resolveLocale(requested: string, available: readonly string[]): string {
  if (available.includes(requested)) return requested;
  const lang = requested.toLowerCase().split('-')[0] ?? '';
  if (available.includes(lang)) return lang;
  return SOURCE_LOCALE;
}

/**
 * Suggest a locale from the browser's preferences (used once, at setup).
 * `no` and `nn` map to `nb` when there is no `nn` translation.
 */
export function suggestLocale(preferred: readonly string[], available: readonly string[]): string {
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    if (available.includes(lower)) return lower;
    const lang = lower.split('-')[0] ?? '';
    if (available.includes(lang)) return lang;
    if ((lang === 'no' || lang === 'nn') && available.includes('nb')) return 'nb';
  }
  return SOURCE_LOCALE;
}

export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

export interface Translator {
  locale: string;
  t: TFunction;
  meta: LocaleMeta;
}

export function createTranslator(
  locale: string,
  catalogs: Catalogs,
  onMissing?: (key: string, locale: string) => void,
): Translator {
  const resolved = resolveLocale(locale, Object.keys(catalogs));
  const chain = [resolved, resolved.split('-')[0] ?? '', SOURCE_LOCALE].filter(
    (l, i, a) => l && a.indexOf(l) === i && catalogs[l],
  );
  const flat = chain.map((l) => flatten(catalogs[l] as Record<string, unknown>));
  const plural = new Intl.PluralRules(resolved);

  const lookup = (key: string): string | undefined => {
    for (let i = 0; i < flat.length; i++) {
      const v = flat[i]?.[key];
      if (v !== undefined) {
        if (i > 0 && chain[i] === SOURCE_LOCALE && resolved !== SOURCE_LOCALE)
          onMissing?.(key, resolved);
        return v;
      }
    }
    return undefined;
  };

  const t: TFunction = (key, params) => {
    let template: string | undefined;
    if (params && typeof params.count === 'number') {
      template = lookup(`${key}_${plural.select(params.count)}`) ?? lookup(`${key}_other`);
    }
    template ??= lookup(key);
    if (template === undefined) {
      onMissing?.(key, resolved);
      return key;
    }
    return interpolate(template, params);
  };

  const meta = (catalogs[resolved] ?? catalogs[SOURCE_LOCALE])!._meta;
  return { locale: resolved, t, meta };
}
