// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Serves the built PWA (dist/web) the way Workers Static Assets does, so both
 * platforms behave the same:
 * - security and cache headers come from the same `_headers` file,
 * - unknown paths fall back to index.html (single-page app),
 * - but a missing hashed file under /assets/ is a 404 (never HTML cached as
 *   immutable JS/CSS),
 * - files outside the build directory, dotfiles and `_headers` are never served.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

interface HeaderRule {
  pattern: string;
  headers: [string, string][];
}

/** Parse the subset of Cloudflare's `_headers` format we use: path patterns with `*`. */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(':');
      if (i > 0) current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(path);
}

export function createStaticHandler(root: string) {
  const dir = normalize(root);
  const headersFile = join(dir, '_headers');
  const rules = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, 'utf8')) : [];
  const index = join(dir, 'index.html');

  const withHeaders = (path: string, res: Response): Response => {
    for (const rule of rules) {
      if (matches(rule.pattern, path)) for (const [k, v] of rule.headers) res.headers.set(k, v);
    }
    return res;
  };

  /** Resolve a URL path to a file inside the build directory, or null. */
  const resolveFile = (pathname: string): string | null => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.split('/').some((seg) => seg.startsWith('.')) || decoded === '/_headers')
      return null;
    const file = normalize(join(dir, decoded));
    if (file !== dir && !file.startsWith(dir + sep)) return null; // path traversal
    try {
      const st = statSync(file);
      if (st.isFile()) return file;
      if (st.isDirectory() && existsSync(join(file, 'index.html'))) return join(file, 'index.html');
    } catch {
      // not found
    }
    return null;
  };

  return function serveStatic(req: Request): Response {
    const { pathname } = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const file = resolveFile(pathname);
    if (file) return withHeaders(pathname, new Response(Bun.file(file)));
    if (pathname.startsWith('/assets/')) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    // Single-page app: every other path renders the app shell.
    return withHeaders(
      '/',
      new Response(Bun.file(index), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
  };
}
