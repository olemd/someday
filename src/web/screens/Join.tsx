// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * /join/<token>: a list invite (§3.1). Logged in → join with one tap.
 * Logged out → log in (and come back here) or create an account, which
 * joins the list in the same step.
 */
import { useEffect, useState } from 'preact/hooks';
import { showError } from '../components/Toast';
import { ApiError, get, post } from '../lib/api';
import { sync } from '../lib/data';
import { t } from '../lib/i18n';
import { navigate, route } from '../lib/router';
import { auth, loadAuth } from '../lib/store';
import { Login, Signup } from './Auth';

interface Preview {
  list_name: string;
  inviter: string | null;
  role: 'editor' | 'viewer';
}

export function JoinScreen() {
  const token = route.value.slice('/join/'.length);
  const [preview, setPreview] = useState<Preview | null | 'invalid'>(null);
  const [mode, setMode] = useState<'choose' | 'login' | 'signup'>('choose');
  const [busy, setBusy] = useState(false);
  const authed = !!auth.value?.authenticated;

  useEffect(() => {
    get<Preview>(`/join/${encodeURIComponent(token)}`).then(setPreview, (err) =>
      setPreview(err instanceof ApiError ? 'invalid' : null),
    );
  }, [token]);

  if (preview === 'invalid') {
    return (
      <section class="panel stack">
        <h1 tabIndex={-1}>{t('join.invalidTitle')}</h1>
        <p>{t('join.invalid')}</p>
        <a href="/">{t('join.home')}</a>
      </section>
    );
  }
  if (!preview) return <p>{t('app.loading')}</p>;

  const intro = (
    <>
      <h1 tabIndex={-1}>{t('join.title', { list: preview.list_name })}</h1>
      <p>
        {preview.inviter
          ? t('join.intro', { name: preview.inviter, role: t(`role.${preview.role}`) })
          : t('join.introAnon', { role: t(`role.${preview.role}`) })}
      </p>
    </>
  );

  if (authed) {
    return (
      <section class="panel stack">
        {intro}
        <button
          type="button"
          class="btn primary large"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ list_id: string }>(`/join/${encodeURIComponent(token)}`);
              await sync();
              navigate(`/lists/${r.list_id}`, true);
            } catch (err) {
              showError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('join.join')}
        </button>
      </section>
    );
  }

  if (mode === 'login') return <Login />;
  if (mode === 'signup') {
    return (
      <Signup
        joinToken={token}
        onDone={async () => {
          await loadAuth();
          navigate('/lists', true);
        }}
      />
    );
  }
  return (
    <section class="panel stack">
      {intro}
      <p>{t('join.needAccount')}</p>
      <div class="actions start">
        <button type="button" class="btn primary" onClick={() => setMode('login')}>
          {t('join.haveAccount')}
        </button>
        <button type="button" class="btn plain" onClick={() => setMode('signup')}>
          {t('join.newAccount')}
        </button>
      </div>
    </section>
  );
}
