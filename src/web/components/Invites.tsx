// SPDX-License-Identifier: AGPL-3.0-or-later
/** Invite someone to this Someday instance (§2.2). */
import { useEffect, useState } from 'preact/hooks';
import { del, get, post } from '../lib/api';
import { calendarDate, dateTime } from '../lib/fmt';
import { t } from '../lib/i18n';
import { auth } from '../lib/store';
import { showError, toast } from './Toast';

interface Invite {
  id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_name: string | null;
}

export function Invites() {
  const [list, setList] = useState<Invite[]>([]);
  const [fresh, setFresh] = useState<{ url: string; expires_at: string } | null>(null);
  const load = () => get<Invite[]>('/invites').then(setList, showError);
  useEffect(() => void load(), []);
  if (auth.value?.registration_mode === 'closed') return null;
  return (
    <section class="panel stack" aria-labelledby="inv-title">
      <h2 id="inv-title">{t('invites.title')}</h2>
      <p class="hint">{t('invites.intro')}</p>
      <button
        type="button"
        class="btn plain"
        onClick={async () => {
          try {
            setFresh(await post<{ url: string; expires_at: string }>('/invites'));
            void load();
          } catch (err) {
            showError(err);
          }
        }}
      >
        {t('invites.create')}
      </button>
      {fresh && (
        <div class="notice stack tight">
          <p>{t('invites.created', { date: calendarDate(fresh.expires_at.slice(0, 10)) })}</p>
          <p class="row">
            <code class="small break">{fresh.url}</code>
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh.url);
                toast(t('link.copied'));
              }}
            >
              {t('common.copy')}
            </button>
          </p>
        </div>
      )}
      {list.length > 0 && (
        <ul class="plain stack tight">
          {list.map((i) => (
            <li key={i.id} class="row">
              <span class="small">
                {i.used_at
                  ? t('invites.usedBy', { name: i.used_by_name ?? '?', date: dateTime(i.used_at) })
                  : Date.parse(i.expires_at) < Date.now()
                    ? t('invites.expired')
                    : t('invites.open', { date: dateTime(i.expires_at) })}
              </span>
              {!i.used_at && (
                <button
                  type="button"
                  class="btn plain small"
                  onClick={async () => {
                    await del(`/invites/${i.id}`).catch(showError);
                    void load();
                  }}
                >
                  {t('common.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
