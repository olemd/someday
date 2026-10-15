// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import { App } from './App';
import { setLocale } from './lib/i18n';

// Before login there are no settings yet: follow the browser (nb for any Norwegian).
const nav = navigator.language.toLowerCase();
void setLocale(/^(nb|nn|no)\b/.test(nav) ? 'nb' : nav).finally(() =>
  render(<App />, document.getElementById('app')!),
);

// Service worker: production builds only, so dev reloads stay simple.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js');
}
