// SPDX-License-Identifier: AGPL-3.0-or-later
/** Home: the "give me something" screen (§4). Filled in by the suggester milestone. */
import { t } from '../lib/i18n';
import { auth } from '../lib/store';

export function HomeScreen() {
  return (
    <div class="stack">
      <h1 tabIndex={-1}>{t('home.greeting', { name: auth.value?.user?.display_name ?? '' })}</h1>
      <p>{t('app.tagline')}</p>
    </div>
  );
}
