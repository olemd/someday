// SPDX-License-Identifier: AGPL-3.0-or-later
/** Settings: profile, language and time zone, notifications, security, invites. */
import { useEffect, useState } from 'preact/hooks';
import { Invites } from '../components/Invites';
import { PushSettings } from '../components/PushSettings';
import { SecuritySettings } from '../components/Security';
import { showError, toast } from '../components/Toast';
import { patch, post } from '../lib/api';
import { localeNames, setLocale, t } from '../lib/i18n';
import { route } from '../lib/router';
import { auth, loadAuth, loadSettings, settings, type Settings } from '../lib/store';

/** Save one or more settings and refresh the local copy. */
export async function saveSettings(p: Partial<Settings>) {
  try {
    settings.value = await patch<Settings>('/settings', p);
    toast(t('common.saved'));
  } catch (err) {
    showError(err);
  }
}

function Profile() {
  const [name, setName] = useState(auth.value?.user?.display_name ?? '');
  const [locales, setLocales] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => void localeNames().then(setLocales), []);
  const s = settings.value!;
  const zones = Intl.supportedValuesOf('timeZone');
  return (
    <section class="panel stack" aria-labelledby="profile-title">
      <h2 id="profile-title">{t('settings.profile')}</h2>
      <form
        class="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await patch('/auth/profile', { display_name: name.trim() });
            await loadAuth();
            toast(t('common.saved'));
          } catch (err) {
            showError(err);
          }
        }}
      >
        <div class="field">
          <label for="p-name">{t('auth.displayName')}</label>
          <div class="inline">
            <input
              id="p-name"
              value={name}
              maxLength={80}
              required
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <button type="submit" class="btn plain">
              {t('common.save')}
            </button>
          </div>
        </div>
      </form>
      <div class="grid-2">
        <div class="field">
          <label for="p-locale">{t('settings.language')}</label>
          <select
            id="p-locale"
            value={s.locale}
            onChange={async (e) => {
              const locale = e.currentTarget.value;
              await saveSettings({ locale });
              await setLocale(locale);
            }}
          >
            {locales.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="p-tz">{t('settings.timezone')}</label>
          <select
            id="p-tz"
            value={s.timezone}
            onChange={(e) => saveSettings({ timezone: e.currentTarget.value })}
          >
            {(zones.includes(s.timezone) ? zones : [s.timezone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}

function Notifications() {
  const s = settings.value!;
  const toggle = (key: 'notify_window' | 'notify_shared' | 'notify_agent', label: string) => (
    <label class="check">
      <input
        type="checkbox"
        checked={s[key]}
        onChange={(e) => saveSettings({ [key]: e.currentTarget.checked })}
      />
      {label}
    </label>
  );
  return (
    <section class="panel stack" id="notifications" aria-labelledby="notif-title">
      <h2 id="notif-title">{t('settings.notifications')}</h2>
      <PushSettings />
      <fieldset class="field">
        <legend>{t('settings.quietHours')}</legend>
        <div class="inline">
          <label class="visually-hidden" for="q-start">
            {t('settings.quietFrom')}
          </label>
          <input
            id="q-start"
            type="text"
            inputMode="numeric"
            pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
            value={s.quiet_start}
            onChange={(e) => saveSettings({ quiet_start: e.currentTarget.value })}
          />
          <span aria-hidden="true">–</span>
          <label class="visually-hidden" for="q-end">
            {t('settings.quietTo')}
          </label>
          <input
            id="q-end"
            type="text"
            inputMode="numeric"
            pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
            value={s.quiet_end}
            onChange={(e) => saveSettings({ quiet_end: e.currentTarget.value })}
          />
        </div>
        <span class="hint">{t('settings.quietHint')}</span>
      </fieldset>
      <fieldset class="field">
        <legend>{t('settings.notifyTypes')}</legend>
        {toggle('notify_window', t('settings.notifyWindow'))}
        {toggle('notify_shared', t('settings.notifyShared'))}
        {toggle('notify_agent', t('settings.notifyAgent'))}
      </fieldset>
    </section>
  );
}

export function SettingsScreen() {
  useEffect(() => {
    void loadSettings().catch(showError);
    // Deep links (/settings/security, /settings/notifications) scroll to their section.
    const section = route.value.split('/')[2];
    if (section) queueMicrotask(() => document.getElementById(section)?.scrollIntoView());
  }, []);
  if (!settings.value) return <p>{t('app.loading')}</p>;
  return (
    <div class="stack">
      <h1 tabIndex={-1}>{t('nav.settings')}</h1>
      <Profile />
      <Notifications />
      <SecuritySettings />
      <Invites />
      <div class="actions">
        <button
          type="button"
          class="btn plain"
          onClick={async () => {
            await post('/auth/logout').catch(() => undefined);
            navigator.serviceWorker?.controller?.postMessage('clear-api-cache');
            location.assign('/');
          }}
        >
          {t('auth.logout')}
        </button>
      </div>
    </div>
  );
}
