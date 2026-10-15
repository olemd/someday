// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account security (§2.1): passkeys, "add another device" links, sessions
 * and recovery codes. Sensitive actions ask for a fresh passkey assertion.
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, del, get, patch, post } from '../lib/api';
import { dateTime, time } from '../lib/fmt';
import { t } from '../lib/i18n';
import { addPasskey, defaultPasskeyLabel, reauthenticate } from '../lib/passkey';
import { loadSettings, settings } from '../lib/store';
import { RecoveryCodes, errorText } from '../screens/Auth';
import { ask, confirmAction } from './Dialog';
import { Qr } from './Qr';
import { showError, toast } from './Toast';

/** Run `fn`; if the server wants a fresh passkey assertion, get one and retry once. */
export async function withReauth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'reauth_required')) throw err;
    await reauthenticate();
    return fn();
  }
}

interface Passkey {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

function Passkeys() {
  const [keys, setKeys] = useState<Passkey[]>([]);
  const load = () => get<Passkey[]>('/auth/passkeys').then(setKeys, showError);
  useEffect(() => void load(), []);
  return (
    <div class="stack">
      <h3>{t('security.passkeys')}</h3>
      <ul class="plain stack tight">
        {keys.map((k) => (
          <li key={k.id} class="row">
            <span>
              {k.label}
              {k.current && <> ({t('common.thisDevice')})</>}
              <br />
              <span class="muted small">
                {k.last_used_at
                  ? t('common.lastUsed', { date: dateTime(k.last_used_at) })
                  : t('common.neverUsed')}
              </span>
            </span>
            <span class="actions">
              <button
                type="button"
                class="btn plain small"
                onClick={async () => {
                  const label = prompt(t('security.renamePrompt'), k.label)?.trim();
                  if (!label) return;
                  await patch(`/auth/passkeys/${encodeURIComponent(k.id)}`, { label }).catch(
                    showError,
                  );
                  void load();
                }}
              >
                {t('common.rename')}
              </button>
              <button
                type="button"
                class="btn danger-plain small"
                disabled={keys.length < 2}
                aria-disabled={keys.length < 2}
                title={keys.length < 2 ? t('security.lastPasskey') : undefined}
                onClick={async () => {
                  if (
                    !(await confirmAction(
                      t('security.deletePasskeyConfirm', { label: k.label }),
                      t('common.delete'),
                      true,
                    ))
                  )
                    return;
                  await del(`/auth/passkeys/${encodeURIComponent(k.id)}`).catch(showError);
                  if (k.current) location.assign('/');
                  else void load();
                }}
              >
                {t('common.delete')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        class="btn plain"
        onClick={async () => {
          try {
            await withReauth(() => addPasskey(defaultPasskeyLabel()));
            toast(t('security.passkeyAdded'));
            void load();
          } catch (err) {
            toast(errorText(err), { kind: 'error' });
          }
        }}
      >
        {t('security.addPasskeyHere')}
      </button>
    </div>
  );
}

interface NewLink {
  id: string;
  url: string;
  code: string;
  expires_at: string;
  require_approval: boolean;
}
interface ActiveLink {
  id: string;
  expires_at: string;
  claimed: boolean;
  approved: boolean;
  approval_choices: number[] | null;
  claim_user_agent: string | null;
}

/** "Add another device": link + QR + short code, and approval when required. */
function DeviceLink() {
  const [link, setLink] = useState<NewLink | null>(null);
  const [state, setState] = useState<ActiveLink | null>(null);

  // While a link is shown, watch it: claimed → maybe approve; gone → done.
  useEffect(() => {
    if (!link) return;
    const tick = async () => {
      try {
        const active = await get<ActiveLink[]>('/links');
        const mine = active.find((l) => l.id === link.id) ?? null;
        if (!mine) {
          setLink(null);
          setState(null);
          if (Date.parse(link.expires_at) > Date.now()) toast(t('link.deviceAdded'));
          return;
        }
        setState(mine);
      } catch {
        // offline for a moment; try again next tick
      }
    };
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, [link]);

  const create = async () => {
    try {
      setLink(await withReauth(() => post<NewLink>('/links')));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'too_many_links') {
        toast(t('link.tooMany'), { kind: 'error' });
      } else toast(errorText(err), { kind: 'error' });
    }
  };

  const approve = async (number: number) => {
    try {
      await post(`/links/${link!.id}/approve`, { number });
      toast(t('link.approved'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'wrong_number') {
        toast(t('link.wrongNumber'), { kind: 'error' });
        setLink(null);
      } else showError(err);
    }
  };

  return (
    <div class="stack">
      <h3>{t('link.addDevice')}</h3>
      <p class="hint">{t('link.addDeviceIntro')}</p>
      {!link ? (
        <button type="button" class="btn plain" onClick={create}>
          {t('link.create')}
        </button>
      ) : (
        <div class="panel stack">
          <Qr value={link.url} label={t('link.qrLabel')} />
          <p>{t('link.orOpen')}</p>
          <p class="row">
            <code class="small break">{link.url}</code>
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                await navigator.clipboard.writeText(link.url);
                toast(t('link.copied'));
              }}
            >
              {t('common.copy')}
            </button>
          </p>
          <p>{t('link.orType')}</p>
          <p class="code-big">
            <span aria-hidden="true">{link.code}</span>
            {/* Read character by character by screen readers. */}
            <span class="visually-hidden">{link.code.split('').join(' ')}</span>
          </p>
          <p class="hint">{t('link.expires', { time: time(link.expires_at) })}</p>
          {state?.approval_choices && (
            <div class="stack" role="alert">
              <p>{t('link.pickNumber')}</p>
              <div class="actions start">
                {state.approval_choices.map((n) => (
                  <button key={n} type="button" class="btn plain large" onClick={() => approve(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div class="actions">
            <button
              type="button"
              class="btn plain"
              onClick={async () => {
                await del(`/links/${link.id}`).catch(() => undefined);
                setLink(null);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      <label class="check">
        <input
          type="checkbox"
          checked={settings.value?.require_link_approval ?? false}
          onChange={async (e) => {
            await patch('/settings', { require_link_approval: e.currentTarget.checked }).catch(
              showError,
            );
            await loadSettings();
          }}
        />
        {t('link.requireApproval')}
      </label>
    </div>
  );
}

interface Session {
  id: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string;
  current: boolean;
}

function Sessions() {
  const [list, setList] = useState<Session[]>([]);
  const load = () => get<Session[]>('/auth/sessions').then(setList, showError);
  useEffect(() => void load(), []);
  return (
    <div class="stack">
      <h3>{t('security.sessions')}</h3>
      <ul class="plain stack tight">
        {list.map((s) => (
          <li key={s.id} class="row">
            <span>
              <span class="small">{s.user_agent || t('security.unknownBrowser')}</span>
              {s.current && <> ({t('common.thisDevice')})</>}
              <br />
              <span class="muted small">
                {t('common.lastUsed', { date: dateTime(s.last_seen_at) })}
              </span>
            </span>
            {!s.current && (
              <button
                type="button"
                class="btn plain small"
                onClick={async () => {
                  await del(`/auth/sessions/${s.id}`).catch(showError);
                  void load();
                }}
              >
                {t('security.logOutSession')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {list.length > 1 && (
        <button
          type="button"
          class="btn plain"
          onClick={async () => {
            await post('/auth/logout-others').catch(showError);
            void load();
          }}
        >
          {t('security.logOutOthers')}
        </button>
      )}
    </div>
  );
}

function Recovery() {
  const [remaining, setRemaining] = useState<number | null>(null);
  const load = () =>
    get<{ remaining: number }>('/auth/recovery-codes').then((r) => setRemaining(r.remaining));
  useEffect(() => void load().catch(showError), []);
  return (
    <div class="stack">
      <h3>{t('security.recovery')}</h3>
      <p>{remaining !== null && t('security.recoveryRemaining', { count: remaining })}</p>
      <button
        type="button"
        class="btn plain"
        onClick={async () => {
          if (!(await confirmAction(t('security.newCodesConfirm'), t('security.newCodes')))) return;
          try {
            const r = await withReauth(() =>
              post<{ recovery_codes: string[] }>('/auth/recovery-codes'),
            );
            await ask(
              t('auth.recoveryTitle'),
              [{ label: t('common.close'), value: true }],
              <RecoveryCodes codes={r.recovery_codes} onDone={() => undefined} />,
            );
            void load();
          } catch (err) {
            toast(errorText(err), { kind: 'error' });
          }
        }}
      >
        {t('security.newCodes')}
      </button>
    </div>
  );
}

export function SecuritySettings() {
  return (
    <section class="panel stack" id="security" aria-labelledby="security-title">
      <h2 id="security-title">{t('security.title')}</h2>
      <Passkeys />
      <DeviceLink />
      <Sessions />
      <Recovery />
    </section>
  );
}
