// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Push notifications on this device (§5): subscribe with the server's VAPID
 * key, send a test, list and remove devices. iOS only supports push for
 * apps installed to the home screen, which is explained when relevant.
 */
import { useEffect, useState } from 'preact/hooks';
import { fromBase64Url } from '../../core/crypto';
import { api, get, post } from '../lib/api';
import { dateTime } from '../lib/fmt';
import { t } from '../lib/i18n';
import { defaultPasskeyLabel } from '../lib/passkey';
import { auth } from '../lib/store';
import { showError, toast } from './Toast';

interface Sub {
  endpoint: string;
  label: string | null;
  created_at: string;
  last_ok_at: string | null;
}

const supported = () =>
  'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;

export function PushSettings() {
  const key = auth.value?.push_public_key ?? null;
  const [subs, setSubs] = useState<Sub[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setSubs(await get<Sub[]>('/push/subscriptions'));
      if (supported()) {
        const reg = await navigator.serviceWorker.getRegistration();
        setMine((await reg?.pushManager.getSubscription())?.endpoint ?? null);
      }
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => void load(), []);

  const enable = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        toast(t('push.denied'), { kind: 'error' });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(key!),
      });
      await post('/push/subscribe', {
        endpoint: sub.endpoint,
        keys: sub.toJSON().keys,
        label: defaultPasskeyLabel(),
      });
      toast(t('push.enabledToast'));
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  /** Remove a device; for this device also unsubscribe in the browser. */
  const remove = async (endpoint: string) => {
    try {
      if (endpoint === mine) {
        const reg = await navigator.serviceWorker.getRegistration();
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
      }
      await api('/push/subscribe', { method: 'DELETE', json: { endpoint } });
      await load();
    } catch (err) {
      showError(err);
    }
  };

  let state: preact.ComponentChildren;
  if (key === null) state = <p class="notice">{t('push.notConfigured')}</p>;
  else if (isIos() && !isStandalone()) state = <p class="notice">{t('push.iosInstall')}</p>;
  else if (!supported()) state = <p class="notice">{t('push.unsupported')}</p>;
  else if (Notification.permission === 'denied') state = <p class="notice">{t('push.denied')}</p>;
  else if (mine && subs.some((s) => s.endpoint === mine)) state = <p>{t('push.thisDeviceOn')}</p>;
  else
    state = (
      <button type="button" class="btn plain" disabled={busy} onClick={enable}>
        {t('push.enable')}
      </button>
    );

  return (
    <div class="stack">
      <h3>{t('push.title')}</h3>
      {state}
      {subs.length > 0 && (
        <>
          <h3>{t('push.devices')}</h3>
          <ul class="plain stack tight">
            {subs.map((s) => (
              <li key={s.endpoint} class="row">
                <span>
                  {s.label ?? new URL(s.endpoint).host}
                  {s.endpoint === mine && <> ({t('common.thisDevice')})</>}
                  <br />
                  <span class="muted small">
                    {s.last_ok_at
                      ? t('common.lastUsed', { date: dateTime(s.last_ok_at) })
                      : t('common.neverUsed')}
                  </span>
                </span>
                <button
                  type="button"
                  class="btn plain small"
                  onClick={() => void remove(s.endpoint)}
                >
                  {t('common.remove')}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            class="btn plain"
            onClick={async () => {
              try {
                const r = await post<{ sent: number }>('/push/test');
                toast(t('push.testSent', { count: r.sent }));
              } catch (err) {
                showError(err);
              }
            }}
          >
            {t('push.test')}
          </button>
        </>
      )}
    </div>
  );
}
