// SPDX-License-Identifier: AGPL-3.0-or-later
export {};
/** Fails if a source file lacks the SPDX header (§15.6). JSON files cannot carry comments and are exempt. */
const HEADER = 'SPDX-License-Identifier: AGPL-3.0-or-later';
const globs = [
  'src/**/*.{ts,tsx,css,sql,html}',
  'scripts/**/*.ts',
  'test/**/*.ts',
  'migrations/**/*.sql',
  '*.{ts,js}',
];
const skip = /catalogs\.generated\.ts$/;
let bad = 0;
for (const pattern of globs) {
  for await (const file of new Bun.Glob(pattern).scan({ cwd: '.', dot: false })) {
    if (skip.test(file) || file.startsWith('node_modules/')) continue;
    const head = (await Bun.file(file).text()).slice(0, 300);
    if (!head.includes(HEADER)) {
      console.error(`missing SPDX header: ${file}`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log('SPDX headers OK');
