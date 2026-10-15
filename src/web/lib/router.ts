// SPDX-License-Identifier: AGPL-3.0-or-later
/** Minimal history router. Workers Static Assets serves index.html for unknown paths. */
import { signal } from '@preact/signals';

export const route = signal(location.pathname);
export const query = signal(new URLSearchParams(location.search));

export function navigate(href: string, replace = false) {
  const url = new URL(href, location.origin);
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  route.value = url.pathname;
  query.value = url.searchParams;
  // Move focus to the new page's heading for screen reader and keyboard users.
  queueMicrotask(() => document.querySelector<HTMLElement>('main h1')?.focus());
}

/**
 * Replace the current URL's query (e.g. report filters) without a history
 * entry or moving focus, so a filter control keeps focus while it changes.
 * Empty values are dropped to keep URLs short.
 */
export function setQuery(params: Record<string, string | null | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const search = q.toString();
  history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}`);
  query.value = q;
}

addEventListener('popstate', () => {
  route.value = location.pathname;
  query.value = new URLSearchParams(location.search);
});

/** Intercept same-origin <a> clicks so links work without full reloads. */
export function onLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a');
  if (
    !a ||
    a.target ||
    a.hasAttribute('download') ||
    a.pathname.startsWith('/api/') ||
    a.origin !== location.origin ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey
  )
    return;
  e.preventDefault();
  navigate(a.pathname + a.search);
}
