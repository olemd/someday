// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Noticing a new release while the app is open. Files are cache-busted
 * already (hashed /assets, no-cache sw.js, network-first navigations), but a
 * tab or installed app that stays open keeps running the JavaScript it
 * loaded. Every API response says which version the server runs
 * (`x-app-version`); when it differs from this build, the service worker is
 * asked to fetch the new one and the app offers a reload. Queued offline
 * writes live in IndexedDB, so reloading never loses them.
 */
import { signal } from '@preact/signals';

/** Local and test servers report this; never prompt for it. */
const DEV = '0.0.0-dev';

export const updateReady = signal(false);

export function noteServerVersion(version: string | null): void {
  if (!version || updateReady.value) return;
  if (version === __APP_VERSION__ || version === DEV || __APP_VERSION__ === DEV) return;
  updateReady.value = true;
  void navigator.serviceWorker
    ?.getRegistration()
    .then((r) => r?.update())
    .catch(() => undefined);
}
