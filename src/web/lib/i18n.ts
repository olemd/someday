// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web-side locale loading (§7.5). Locales are discovered at build time with
 * import.meta.glob, so dropping in a new JSON file adds a language. English is
 * bundled (it is the fallback); other languages load on demand.
 */
import { signal } from '@preact/signals';
import en from '../../shared/i18n/en.json';
import {
  createTranslator,
  type Catalog,
  type Catalogs,
  type Translator,
} from '../../shared/i18n/translate';

// en.json is excluded from the lazy glob because it is bundled statically above.
const loaders = import.meta.glob<Catalog>(
  ['../../shared/i18n/*.json', '!../../shared/i18n/en.json'],
  { import: 'default' },
);

const fileLocale = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.json'.length);

export const availableLocales: string[] = ['en', ...Object.keys(loaders).map(fileLocale)].sort();

const loaded: Catalogs = { en: en as unknown as Catalog };

const warn = import.meta.env.DEV
  ? (key: string, locale: string) => console.warn(`[i18n] missing ${locale}: ${key}`)
  : undefined;

export const translator = signal<Translator>(createTranslator('en', loaded, warn));

/** Load metadata for all locales (for the language picker). */
export async function localeNames(): Promise<{ code: string; name: string }[]> {
  const out = [];
  for (const code of availableLocales) {
    const cat = loaded[code] ?? (await loaders[`../../shared/i18n/${code}.json`]!());
    loaded[code] = cat;
    out.push({ code, name: cat._meta.name });
  }
  return out;
}

export async function setLocale(locale: string): Promise<void> {
  const tag = locale.toLowerCase();
  for (const code of [tag, tag.split('-')[0]!]) {
    const key = `../../shared/i18n/${code}.json`;
    if (!loaded[code] && loaders[key]) loaded[code] = await loaders[key]!();
  }
  const tr = createTranslator(locale, loaded, warn);
  document.documentElement.lang = tr.locale;
  document.documentElement.dir = tr.meta.dir;
  translator.value = tr;
}

export const t = (key: string, params?: Record<string, string | number>) =>
  translator.value.t(key, params);
