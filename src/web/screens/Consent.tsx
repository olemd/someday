// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * /oauth/authorize — consent for an MCP client (§8.1). Shows the client's
 * name and where it will send you back (with a warning for localhost-only
 * redirects), lets you narrow the scopes and restrict it to some lists.
 */
import { useEffect, useState } from 'preact/hooks';
import { showError } from '../components/Toast';
import { get, post } from '../lib/api';
import { t } from '../lib/i18n';
import { query } from '../lib/router';

type Scope = 'someday:read' | 'someday:write' | 'someday:notify';
interface Info {
  ok: true;
  client: { client_id: string; client_name: string; client_uri: string | null; kind: string };
  redirect_host: string;
  localhost: boolean;
  scopes: Scope[];
  lists: { id: string; name: string; role: string }[];
}
type Result =
  | Info
  | { ok: false; redirect: string }
  | { ok: false; error: string; message: string };

const PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'state',
  'resource',
] as const;

export function ConsentScreen() {
  const params = Object.fromEntries(
    PARAMS.map((k) => [k, query.value.get(k) ?? undefined]).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const [info, setInfo] = useState<Result | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [restrict, setRestrict] = useState(false);
  const [lists, setLists] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<Result>(`/oauth/authorize?${new URLSearchParams(params)}`).then((r) => {
      // Problems the client must hear about go back to it at once.
      if (!r.ok && 'redirect' in r) return location.assign(r.redirect);
      setInfo(r);
      if (r.ok) {
        setScopes(r.scopes);
        setLists(r.lists.map((l) => l.id));
      }
    }, showError);
  }, []);

  if (!info) return <p>{t('app.loading')}</p>;
  if (!info.ok) {
    return (
      <section class="panel stack">
        <h1 tabIndex={-1}>{t('consent.errorTitle')}</h1>
        <p class="notice error">{'message' in info ? info.message : ''}</p>
        <a href="/">{t('join.home')}</a>
      </section>
    );
  }

  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(true);
    try {
      const r = await post<{ redirect: string }>('/oauth/authorize', {
        ...params,
        decision,
        granted_scopes: scopes,
        list_ids: restrict ? lists : null,
      });
      location.assign(r.redirect);
    } catch (err) {
      showError(err);
      setBusy(false);
    }
  };

  return (
    <section class="panel stack" aria-labelledby="consent-title">
      <h1 id="consent-title" tabIndex={-1}>
        {t('consent.title', { name: info.client.client_name })}
      </h1>
      <p>{t('consent.intro')}</p>
      <dl class="stack tight">
        <div>
          <dt class="muted small">{t('consent.clientId')}</dt>
          <dd class="flush break">
            <code class="small">{info.client.client_id}</code>
          </dd>
        </div>
        <div>
          <dt class="muted small">{t('consent.redirect')}</dt>
          <dd class="flush">
            <strong>{info.redirect_host}</strong>
          </dd>
        </div>
      </dl>
      {info.localhost && (
        <p class="notice error" role="note">
          {t('consent.localhostWarning')}
        </p>
      )}
      <fieldset class="field">
        <legend>{t('consent.scopes')}</legend>
        {info.scopes.map((s) => (
          <label class="check" key={s}>
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              onChange={(e) =>
                setScopes(e.currentTarget.checked ? [...scopes, s] : scopes.filter((x) => x !== s))
              }
            />
            <span>
              {t(`consent.scope_${s.split(':')[1]}`)}
              <br />
              <span class="hint">{t(`consent.scope_${s.split(':')[1]}Hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset class="field">
        <legend>{t('consent.lists')}</legend>
        <label class="radio">
          <input
            type="radio"
            name="restrict"
            checked={!restrict}
            onChange={() => setRestrict(false)}
          />
          {t('consent.allLists')}
        </label>
        <label class="radio">
          <input
            type="radio"
            name="restrict"
            checked={restrict}
            onChange={() => setRestrict(true)}
          />
          {t('consent.someLists')}
        </label>
        {restrict &&
          info.lists.map((l) => (
            <label class="check" key={l.id}>
              <input
                type="checkbox"
                checked={lists.includes(l.id)}
                onChange={(e) =>
                  setLists(
                    e.currentTarget.checked ? [...lists, l.id] : lists.filter((x) => x !== l.id),
                  )
                }
              />
              {l.name}
            </label>
          ))}
      </fieldset>
      <div class="actions">
        <button type="button" class="btn plain" disabled={busy} onClick={() => decide('deny')}>
          {t('consent.deny')}
        </button>
        <button
          type="button"
          class="btn primary"
          disabled={busy || !scopes.length || (restrict && !lists.length)}
          onClick={() => decide('allow')}
        >
          {t('consent.allow')}
        </button>
      </div>
    </section>
  );
}
