// SPDX-License-Identifier: AGPL-3.0-or-later
/** Connected apps (§8.1): MCP clients with access, their scopes, last use; revoke. */
import { useEffect, useState } from 'preact/hooks';
import { del, get } from '../lib/api';
import { dateTime } from '../lib/fmt';
import { t } from '../lib/i18n';
import { confirmAction } from './Dialog';
import { showError } from './Toast';

interface Grant {
  id: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  lists: string[] | null;
  created_at: string;
  last_used_at: string | null;
}

export function ConnectedApps() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const load = () => get<Grant[]>('/oauth/grants').then(setGrants, showError);
  useEffect(() => void load(), []);
  return (
    <section class="panel stack" id="apps" aria-labelledby="apps-title">
      <h2 id="apps-title">{t('apps.title')}</h2>
      <p class="hint">{t('apps.intro', { url: `${location.origin}/mcp` })}</p>
      {grants.length === 0 ? (
        <p class="muted">{t('apps.none')}</p>
      ) : (
        <ul class="plain stack tight">
          {grants.map((g) => (
            <li key={g.id} class="row">
              <span>
                <strong>{g.client_name}</strong>
                <br />
                <span class="small">
                  {g.scopes.map((s) => t(`consent.scope_${s.split(':')[1]}`)).join(', ')}
                  {' · '}
                  {g.lists ? g.lists.join(', ') : t('consent.allLists')}
                </span>
                <br />
                <span class="muted small">
                  {g.last_used_at
                    ? t('common.lastUsed', { date: dateTime(g.last_used_at) })
                    : t('common.neverUsed')}
                </span>
              </span>
              <button
                type="button"
                class="btn danger-plain small"
                onClick={async () => {
                  if (
                    !(await confirmAction(
                      t('apps.revokeConfirm', { name: g.client_name }),
                      t('apps.revoke'),
                      true,
                    ))
                  )
                    return;
                  await del(`/oauth/grants/${g.id}`).catch(showError);
                  void load();
                }}
              >
                {t('apps.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
