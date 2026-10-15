// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
/**
 * Service worker (§6). Hand-written, no Workbox:
 * - precaches the app shell (list injected at build time),
 * - navigations: network first, cached shell offline,
 * - hashed assets and icons: stale-while-revalidate,
 * - GET /api/*: network first with cache fallback for an allow-list
 *   (the IndexedDB mirror is the main offline store, see lib/db.ts),
 * - push notifications with a deep link and optional action buttons (§5).
 *
 * Self-contained on purpose (no imports), so it builds to one classic script.
 */
// `export {}` (end of file) makes this a module so `self` can be re-typed.
declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __VERSION__: string;

const SHELL = `shell-${__VERSION__}`;
const API = 'api-v1';
const KEEP_SHELLS = 2; // keep the previous version for tabs still running old JS

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(__PRECACHE__);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const shells = (await caches.keys()).filter((k) => k.startsWith('shell-') && k !== SHELL);
      for (const old of shells.slice(0, Math.max(0, shells.length - (KEEP_SHELLS - 1)))) {
        await caches.delete(old);
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * Only GET endpoints needed to boot offline are cached. Item data lives in
 * IndexedDB (sync, §6); passkeys, sessions, exports and tokens stay off disk.
 */
const OFFLINE_API = /^\/api\/(auth\/status|settings|notices)\/?$/;

/** Bumped when logout clears the API cache, so an in-flight response is not written back. */
let generation = 0;

self.addEventListener('message', (event) => {
  if (event.data === 'clear-api-cache') {
    generation++;
    event.waitUntil(caches.delete(API));
  }
});

async function networkFirst(
  request: Request,
  cacheName: string,
  fallback: string | undefined,
  keepAlive: (p: Promise<unknown>) => void,
): Promise<Response> {
  const gen = generation;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const copy = res.clone();
      keepAlive(
        (async () => {
          if (gen !== generation) return;
          const cache = await caches.open(cacheName);
          await cache.put(request, copy);
          if (gen !== generation) await cache.delete(request);
        })(),
      );
    }
    return res;
  } catch (err) {
    const cached =
      (await caches.match(request)) ?? (fallback ? await caches.match(fallback) : undefined);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(
  request: Request,
  keepAlive: (p: Promise<unknown>) => void,
): Promise<Response> {
  const cached = await caches.match(request);
  const refresh = fetch(request).then(async (res) => {
    if (res.ok) await (await caches.open(SHELL)).put(request, res.clone());
    return res;
  });
  if (cached) {
    keepAlive(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  const keep = (p: Promise<unknown>) => event.waitUntil(p);
  if (url.pathname.startsWith('/api/')) {
    if (!OFFLINE_API.test(url.pathname)) return;
    event.respondWith(networkFirst(request, API, undefined, keep));
  } else if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL, '/', keep));
  } else if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(request, keep));
  }
});

// ── Push (§5) ──────────────────────────────────────────────────────────

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  actions?: { action: string; title: string; url: string }[];
}

self.addEventListener('push', (event) => {
  const data = (event.data?.json() ?? { title: 'Someday', body: '', url: '/' }) as PushPayload;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag ?? 'someday',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data,
      ...(data.actions
        ? { actions: data.actions.map(({ action, title }) => ({ action, title })) }
        : {}),
    } as NotificationOptions),
  );
});

/** Focus an open window on `url`, or open one. Only same-origin paths are followed. */
async function openUrl(url: string) {
  const target = new URL(url, self.location.origin);
  if (target.origin !== self.location.origin) return;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const win = wins[0];
  if (win) {
    await win.focus();
    await win.navigate(target.href).catch(() => undefined);
  } else {
    await self.clients.openWindow(target.href);
  }
}

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification.data ?? { url: '/' }) as PushPayload;
  event.notification.close();
  const action = data.actions?.find((a) => a.action === event.action);
  event.waitUntil(openUrl(action?.url ?? data.url ?? '/'));
});
export {};
