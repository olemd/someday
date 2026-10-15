// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rasterises the PWA icons from src/web/icons/*.svg into src/web/public/icons
 * (§7.2: 192/512 + maskable). The PNGs are committed, so building does not
 * need rsvg-convert; rerun this after changing the SVGs.
 */
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const src = join(root, 'src/web/icons');
const out = join(root, 'src/web/public/icons');
const jobs: [string, string, number][] = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['maskable.svg', 'maskable-512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
];
for (const [svg, png, size] of jobs) {
  const r = Bun.spawnSync([
    'rsvg-convert',
    '-w',
    String(size),
    '-h',
    String(size),
    '-o',
    join(out, png),
    join(src, svg),
  ]);
  if (!r.success) throw new Error(`rsvg-convert failed for ${png}: ${r.stderr.toString()}`);
}
copyFileSync(join(src, 'icon.svg'), join(out, 'icon.svg'));
console.log(`icons written to ${out}`);
