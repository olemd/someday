// SPDX-License-Identifier: AGPL-3.0-or-later
/** Instance administration (§2.3): users, registration mode, stats. No item content. */
import { useEffect, useState } from 'preact/hooks';
import { confirmAction } from '../components/Dialog';
import { showError, toast } from '../components/Toast';
import { get, patch, post } from '../lib/api';
import { dateTime } from '../lib/fmt';
import { t } from '../lib/i18n';
import { auth, loadAuth } from '../lib/store';

interface User {
  id: string;
  display_name: string;
  role: 'admin' | 'user';
  created_at: string;
  disabled_at: string | null;
  deleted_at: string | null;
  last_seen_at: string | null;
}
type Mode = 'invite' | 'open' | 'closed';

export function AdminScreen() {
  const [users, setUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<{ registration_mode: Mode; registration_mode_default: Mode }>();
  const load = async () => {
    try {
      const [u, s, m] = await Promise.all([
        get<User[]>('/admin/users'),
        get<Record<string, number>>('/admin/stats'),
        get<{ registration_mode: Mode; registration_mode_default: Mode }>('/admin/settings'),
      ]);
      setUsers(u);
      setStats(s);
      setMode(m);
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => void load(), []);

  if (auth.value?.user?.role !== 'admin') return <p>{t('admin.forbidden')}</p>;
  return (
    <div class="stack">
      <h1 tabIndex={-1}>{t('nav.admin')}</h1>
      <section class="panel stack" aria-labelledby="reg-title">
        <h2 id="reg-title">{t('admin.registration')}</h2>
        {mode && (
          <div class="field">
            <label for="reg-mode">{t('admin.registrationMode')}</label>
            <select
              id="reg-mode"
              value={mode.registration_mode}
              onChange={async (e) => {
                try {
                  await patch('/admin/settings', { registration_mode: e.currentTarget.value });
                  toast(t('common.saved'));
                  await Promise.all([load(), loadAuth()]);
                } catch (err) {
                  showError(err);
                }
              }}
            >
              {(['invite', 'open', 'closed'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`admin.mode_${m}`)}
                </option>
              ))}
            </select>
            <span class="hint">
              {t('admin.modeDefault', { mode: t(`admin.mode_${mode.registration_mode_default}`) })}
            </span>
          </div>
        )}
      </section>
      <section class="panel stack" aria-labelledby="stats-title">
        <h2 id="stats-title">{t('admin.stats')}</h2>
        <dl class="grid-2">
          {Object.entries(stats).map(([k, v]) => (
            <div key={k}>
              <dt class="muted small">{t(`admin.stat_${k}`)}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section class="panel stack" aria-labelledby="users-title">
        <h2 id="users-title">{t('admin.users')}</h2>
        <ul class="plain stack tight">
          {users.map((u) => (
            <li key={u.id} class="row">
              <span>
                <strong>{u.display_name}</strong>
                {u.role === 'admin' && <span class="badge">{t('admin.roleAdmin')}</span>}
                {u.disabled_at && <span class="badge">{t('admin.disabled')}</span>}
                {u.deleted_at && <span class="badge">{t('admin.deleted')}</span>}
                <br />
                <span class="muted small">
                  {u.last_seen_at
                    ? t('common.lastUsed', { date: dateTime(u.last_seen_at) })
                    : t('common.neverUsed')}
                </span>
              </span>
              {u.id !== auth.value?.user?.id && (
                <button
                  type="button"
                  class={u.disabled_at ? 'btn plain small' : 'btn danger-plain small'}
                  onClick={async () => {
                    if (
                      !u.disabled_at &&
                      !(await confirmAction(
                        t('admin.disableConfirm', { name: u.display_name }),
                        t('admin.disable'),
                        true,
                      ))
                    )
                      return;
                    await post(
                      `/admin/users/${u.id}/${u.disabled_at ? 'enable' : 'disable'}`,
                    ).catch(showError);
                    void load();
                  }}
                >
                  {t(u.disabled_at ? 'admin.enable' : 'admin.disable')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
