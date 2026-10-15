// SPDX-License-Identifier: AGPL-3.0-or-later
/** Footer on every page, including login (§7.1): AGPL §13 source offer. */
import { t } from '../lib/i18n';

export function Footer() {
  return (
    <footer class="footer">
      <span title={__GIT_SHA__}>{t('app.footer', { version: __APP_VERSION__ })}</span>
      {' · '}
      <a href={__SOURCE_URL__} rel="noopener">
        {t('app.source')}
      </a>
    </footer>
  );
}
