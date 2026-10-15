// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builds the Preact PWA to dist/web, served by Workers Static Assets.
 * Version, git SHA and SOURCE_URL are baked in at build time.
 */
import preact from '@preact/preset-vite';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
const gitSha = (() => {
  try {
    return execSync('git describe --always --dirty --abbrev=40', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();

/**
 * Builds src/web/sw/sw.ts to /sw.js and injects the precache list (every
 * emitted file plus the public icons/manifest) and a version derived from it.
 */
function serviceWorker(): Plugin {
  return {
    name: 'someday-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const sw = bundle['sw.js'];
      if (sw?.type !== 'chunk') this.error('sw.js chunk missing');
      const emitted = Object.keys(bundle).filter(
        (f) => f !== 'sw.js' && f !== 'index.html' && !f.endsWith('.map') && f !== '_headers',
      );
      const publicFiles = readdirSync('src/web/public/icons').map((f) => `/icons/${f}`);
      const precache = [
        '/',
        '/manifest.webmanifest',
        ...publicFiles,
        ...emitted.map((f) => `/${f}`),
      ].sort();
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      sw.code = sw.code
        .replace(/__PRECACHE__/g, JSON.stringify(precache))
        .replace(/__VERSION__/g, JSON.stringify(version));
    },
  };
}

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [preact(), serviceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkg.version),
    __GIT_SHA__: JSON.stringify(process.env.GIT_SHA || gitSha),
    __SOURCE_URL__: JSON.stringify(process.env.SOURCE_URL || 'https://github.com/olemd/someday'),
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    // No inline scripts/modules: the CSP is default-src 'self'.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { main: 'src/web/index.html', sw: 'src/web/sw/sw.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
