// SPDX-License-Identifier: AGPL-3.0-or-later
/** Settings: profile, language and time zone, notifications, security, invites. */
import { useEffect, useState } from 'preact/hooks';
import { Invites } from '../components/Invites';
import { YourData } from '../components/YourData';
import { PushSettings } from '../components/PushSettings';
import { SecuritySettings } from '../components/Security';
import { showError, toast } from '../components/Toast';
import { patch, post } from '../lib/api';
import { calendarDate } from '../lib/fmt';
import { clearLocalData } from '../lib/data';
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
            pattern={HM}
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
            pattern={HM}
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

const HM = '([01][0-9]|2[0-3]):[0-5][0-9]';

/** Nudges (§5.1): opt-in, N per week or month at random times in a window, pausable. */
function Nudges() {
  const s = settings.value!;
  const paused = s.nudge_paused_until;
  const pausedNow = paused === 'forever' || (paused !== null && Date.parse(paused) > Date.now());
  const [until, setUntil] = useState('');
  const pauseFor = (days: number) =>
    saveSettings({ nudge_paused_until: new Date(Date.now() + days * 86_400_000).toISOString() });
  return (
    <section class="panel stack" id="nudges" aria-labelledby="nudge-title">
      <h2 id="nudge-title">{t('nudge.title')}</h2>
      <p class="hint">{t('nudge.intro')}</p>
      <label class="check">
        <input
          type="checkbox"
          checked={s.nudge_enabled}
          onChange={(e) => saveSettings({ nudge_enabled: e.currentTarget.checked })}
        />
        {t('nudge.enable')}
      </label>
      {s.nudge_enabled && (
        <>
          <div class="grid-2">
            <div class="field">
              <label for="n-count">{t('nudge.count')}</label>
              <input
                id="n-count"
                type="number"
                min={0}
                max={31}
                value={s.nudge_count}
                onChange={(e) =>
                  saveSettings({
                    nudge_count: Math.max(0, Math.min(31, Number(e.currentTarget.value) || 0)),
                  })
                }
              />
            </div>
            <div class="field">
              <label for="n-period">{t('nudge.per')}</label>
              <select
                id="n-period"
                value={s.nudge_period}
                onChange={(e) =>
                  saveSettings({ nudge_period: e.currentTarget.value as 'week' | 'month' })
                }
              >
                <option value="week">{t('nudge.week')}</option>
                <option value="month">{t('nudge.month')}</option>
              </select>
            </div>
          </div>
          <fieldset class="field">
            <legend>{t('nudge.window')}</legend>
            <div class="inline">
              <label class="visually-hidden" for="n-from">
                {t('settings.quietFrom')}
              </label>
              <input
                id="n-from"
                inputMode="numeric"
                pattern={HM}
                value={s.nudge_window_start}
                onChange={(e) => saveSettings({ nudge_window_start: e.currentTarget.value })}
              />
              <span aria-hidden="true">–</span>
              <label class="visually-hidden" for="n-to">
                {t('settings.quietTo')}
              </label>
              <input
                id="n-to"
                inputMode="numeric"
                pattern={HM}
                value={s.nudge_window_end}
                onChange={(e) => saveSettings({ nudge_window_end: e.currentTarget.value })}
              />
            </div>
            <span class="hint">{t('nudge.windowHint')}</span>
          </fieldset>
          <div class="stack tight">
            <strong>{t('nudge.pause')}</strong>
            {pausedNow ? (
              <p class="row">
                <span>
                  {paused === 'forever'
                    ? t('nudge.pausedForever')
                    : t('nudge.pausedUntil', { date: calendarDate(paused!.slice(0, 10)) })}
                </span>
                <button
                  type="button"
                  class="btn plain small"
                  onClick={() => saveSettings({ nudge_paused_until: null })}
                >
                  {t('nudge.resume')}
                </button>
              </p>
            ) : (
              <div class="actions start">
                <button type="button" class="btn plain small" onClick={() => pauseFor(7)}>
                  {t('nudge.pauseWeek')}
                </button>
                <button type="button" class="btn plain small" onClick={() => pauseFor(30)}>
                  {t('nudge.pauseMonth')}
                </button>
                <button
                  type="button"
                  class="btn plain small"
                  onClick={() => saveSettings({ nudge_paused_until: 'forever' })}
                >
                  {t('nudge.pauseForever')}
                </button>
                <span class="inline">
                  <label class="visually-hidden" for="n-until">
                    {t('nudge.pauseUntil')}
                  </label>
                  <input
                    id="n-until"
                    type="date"
                    value={until}
                    onInput={(e) => setUntil(e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="btn plain small"
                    disabled={!until}
                    onClick={() =>
                      saveSettings({
                        nudge_paused_until: new Date(`${until}T23:59:59`).toISOString(),
                      })
                    }
                  >
                    {t('nudge.pauseUntil')}
                  </button>
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Suggestions() {
  const s = settings.value!;
  return (
    <section class="panel stack" aria-labelledby="sugg-title">
      <h2 id="sugg-title">{t('settings.suggestions')}</h2>
      <div class="field">
        <label for="s-snooze">{t('settings.snoozeDays')}</label>
        <input
          id="s-snooze"
          type="number"
          min={1}
          max={365}
          value={s.snooze_days}
          onChange={(e) =>
            saveSettings({
              snooze_days: Math.max(1, Math.min(365, Number(e.currentTarget.value) || 7)),
            })
          }
        />
      </div>
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
      <Nudges />
      <Suggestions />
      <SecuritySettings />
      <Invites />
      <YourData />
      <div class="actions">
        <button
          type="button"
          class="btn plain"
          onClick={async () => {
            await post('/auth/logout').catch(() => undefined);
            navigator.serviceWorker?.controller?.postMessage('clear-api-cache');
            await clearLocalData();
            location.assign('/');
          }}
        >
          {t('auth.logout')}
        </button>
      </div>
    </div>
  );
}
