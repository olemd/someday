// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Translation consistency check (§7.5), run in CI:
 * - fails on keys that do not exist in en.json (stale),
 * - fails when a translation's {placeholders} differ from English,
 * - fails when _meta is missing or malformed,
 * - only warns on missing keys (incomplete translations are allowed).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { flatten } from '../src/shared/i18n/translate';

const PLURAL = /_(zero|one|two|few|many|other)$/;
const dir = join(import.meta.dir, '..', 'src', 'shared', 'i18n');
const load = async (f: string) => (await Bun.file(join(dir, f)).json()) as Record<string, unknown>;

const en = flatten(await load('en.json'));
const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

/** The English key a translation key corresponds to (plural categories map to `_other`). */
const enKeyFor = (key: string): string | undefined => {
  if (key in en) return key;
  const m = key.match(PLURAL);
  if (m) {
    const other = key.replace(PLURAL, '_other');
    if (other in en) return other;
  }
  return undefined;
};

let errors = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  const raw = await load(file);
  const meta = raw._meta as Record<string, unknown> | undefined;
  if (
    !meta ||
    typeof meta.name !== 'string' ||
    typeof meta.englishName !== 'string' ||
    !['ltr', 'rtl'].includes(meta.dir as string)
  ) {
    console.error(`✗ ${file}: _meta must have name, englishName and dir ("ltr"|"rtl")`);
    errors++;
  }
  const tr = flatten(raw);
  for (const [key, value] of Object.entries(tr)) {
    const enKey = enKeyFor(key);
    if (!enKey) {
      console.error(`✗ ${file}: stale key "${key}" (not in en.json)`);
      errors++;
      continue;
    }
    if (placeholders(value) !== placeholders(en[enKey]!)) {
      console.error(
        `✗ ${file}: placeholders in "${key}" differ from English ({${placeholders(en[enKey]!)}})`,
      );
      errors++;
    }
  }
  const missing = Object.keys(en).filter((k) => {
    if (k in tr) return false;
    // A plural group counts as present if the translation has any category for it.
    const base = k.replace(PLURAL, '');
    return !(PLURAL.test(k) && Object.keys(tr).some((t) => t.replace(PLURAL, '') === base));
  });
  if (missing.length)
    console.warn(
      `! ${file}: ${missing.length} missing key(s): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`,
    );
  else console.log(`✓ ${file}`);
}
if (errors) {
  console.error(`i18n check failed with ${errors} error(s)`);
  process.exit(1);
}
