// SPDX-License-Identifier: AGPL-3.0-or-later
/** Signup (setup / invite / open), login, recovery, and adding this device via a link (§2). */
import { useEffect, useState } from 'preact/hooks';
import { toast } from '../components/Toast';
import { ApiError, get, post } from '../lib/api';
import { t } from '../lib/i18n';
import {
  defaultPasskeyLabel,
  addPasskey,
  loginWithPasskey,
  passkeyErrorMessage,
  passkeysSupported,
  registerViaLink,
  signup,
} from '../lib/passkey';
import { navigate, query, route } from '../lib/router';
import { auth, loadAuth } from '../lib/store';

function Unsupported() {
  return passkeysSupported() ? null : (
    <p class="notice error" role="alert">
      {t('auth.notSupported')}
    </p>
  );
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const known: Record<string, string> = {
      rate_limited: 'auth.rateLimited',
      bad_recovery_code: 'auth.badRecovery',
      bad_invite: 'auth.badInvite',
      bad_setup_token: 'auth.badSetupToken',
      setup_disabled: 'auth.setupDisabled',
      registration_closed: 'auth.registrationClosed',
      invite_required: 'auth.inviteRequired',
      account_disabled: 'auth.accountDisabled',
      account_deleted: 'auth.accountDeleted',
      unknown_passkey: 'auth.unknownPasskey',
      link_not_found: 'link.notFound',
      link_expired: 'link.expired',
      approval_pending: 'link.waiting',
    };
    const key = known[err.code];
    return key ? t(key) : t('auth.failed', { message: err.message });
  }
  return passkeyErrorMessage(err);
}

function ErrorLine({ text }: { text: string }) {
  return text ? (
    <p class="notice error" role="alert">
      {text}
    </p>
  ) : null;
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <section class="panel stack" aria-labelledby="rc-title">
      <h1 id="rc-title" tabIndex={-1}>
        {t('auth.recoveryTitle')}
      </h1>
      <p>{t('auth.recoveryIntro')}</p>
      <ol class="codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div class="actions">
        <button
          type="button"
          class="btn plain"
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join('\n'));
            toast(t('auth.recoveryCopied'));
          }}
        >
          {t('auth.recoveryCopy')}
        </button>
        <button type="button" class="btn primary" onClick={onDone}>
          {t('auth.recoverySaved')}
        </button>
      </div>
    </section>
  );
}

/** /setup?token=… (first admin), /signup?invite=… or /signup (open registration). */
export function Signup(props: { joinToken?: string; onDone?: () => void } = {}) {
  const isSetup = route.value === '/setup';
  const token =
    props.joinToken ??
    (isSetup ? (query.value.get('token') ?? '') : (query.value.get('invite') ?? ''));
  const kind: 'setup' | 'invite' | 'open' | 'join' = props.joinToken
    ? 'join'
    : isSetup
      ? 'setup'
      : token
        ? 'invite'
        : 'open';
  const [name, setName] = useState('');
  const [label, setLabel] = useState(defaultPasskeyLabel());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);

  useEffect(() => {
    if (kind !== 'invite') return;
    get<{ valid: boolean }>(`/invites/check?token=${encodeURIComponent(token)}`)
      .then((r) => setInviteValid(r.valid))
      .catch(() => setInviteValid(null));
  }, [kind, token]);

  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={async () => {
          if (props.onDone) return props.onDone();
          // Drop the token from the address bar and history.
          history.replaceState(null, '', '/');
          await loadAuth();
          navigate('/', true);
        }}
      />
    );
  }

  const blocked =
    (kind === 'setup' && (!token || !auth.value?.setup_available)) ||
    (kind === 'invite' && inviteValid === false) ||
    (kind === 'open' && auth.value?.registration_mode !== 'open');

  return (
    <section class="panel stack" aria-labelledby="signup-title">
      <h1 id="signup-title" tabIndex={-1}>
        {t(isSetup ? 'auth.setupTitle' : 'auth.signupTitle')}
      </h1>
      <Unsupported />
      {kind === 'setup' && !token && <p class="notice error">{t('auth.setupMissingToken')}</p>}
      {kind === 'setup' && token && !auth.value?.setup_available && (
        <p class="notice error">{t('auth.setupDisabled')}</p>
      )}
      {kind === 'invite' && inviteValid === false && (
        <p class="notice error">{t('auth.badInvite')}</p>
      )}
      {kind === 'open' && auth.value?.registration_mode !== 'open' && (
        <p class="notice">{t('auth.inviteRequired')}</p>
      )}
      {!blocked && (
        <form
          class="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              setCodes(await signup(kind, name.trim(), label.trim(), token || undefined));
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>{t('auth.signupIntro')}</p>
          <div class="field">
            <label for="su-name">{t('auth.displayName')}</label>
            <input
              id="su-name"
              value={name}
              maxLength={80}
              required
              autoComplete="nickname"
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <span class="hint">{t('auth.displayNameHint')}</span>
          </div>
          <div class="field">
            <label for="pk-label">{t('auth.passkeyLabel')}</label>
            <input
              id="pk-label"
              value={label}
              maxLength={100}
              required
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
          </div>
          <ErrorLine text={error} />
          <button type="submit" class="btn primary" disabled={busy}>
            {t('auth.createPasskey')}
          </button>
        </form>
      )}
      {!props.joinToken && (
        <p>
          <a href="/">{t('auth.haveAccount')}</a>
        </p>
      )}
    </section>
  );
}

export function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await loadAuth();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const a = auth.value;
  return (
    <section class="panel stack" aria-labelledby="login-title">
      <h1 id="login-title" tabIndex={-1}>
        {t('auth.loginTitle')}
      </h1>
      <p>{t('app.tagline')}</p>
      <Unsupported />
      <ErrorLine text={error} />
      <button
        type="button"
        class="btn primary large"
        disabled={busy}
        onClick={() => run(loginWithPasskey)}
      >
        {t('auth.loginPasskey')}
      </button>
      <p>
        <a href="/link">{t('auth.addThisDevice')}</a>
      </p>
      {a?.registration_mode === 'open' && (
        <p>
          <a href="/signup">{t('auth.createAccount')}</a>
        </p>
      )}
      <details>
        <summary>{t('auth.useRecovery')}</summary>
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => post('/auth/recovery', { code }));
          }}
        >
          <div class="field">
            <label for="rc">{t('auth.recoveryCode')}</label>
            <input
              id="rc"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellcheck={false}
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
              required
            />
          </div>
          <button type="submit" class="btn plain" disabled={busy}>
            {t('auth.recoveryLogin')}
          </button>
        </form>
      </details>
    </section>
  );
}

export function MustRegister() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section class="panel stack" aria-labelledby="mr-title">
      <h1 id="mr-title" tabIndex={-1}>
        {t('auth.mustRegisterTitle')}
      </h1>
      <p>{t('auth.mustRegisterIntro')}</p>
      <Unsupported />
      <ErrorLine text={error} />
      <button
        type="button"
        class="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await addPasskey(defaultPasskeyLabel());
            await loadAuth();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('auth.createPasskey')}
      </button>
    </section>
  );
}

interface Claim {
  claim: string;
  display_name: string;
  require_approval: boolean;
  approval_number: number | null;
}

/**
 * /link/<token> or /link: this device joins an existing account. Claim the
 * link (or typed code), wait for approval if required, then create a passkey.
 */
export function NewDevice() {
  const token = route.value.startsWith('/link/') ? route.value.slice('/link/'.length) : '';
  const [code, setCode] = useState('');
  const [claim, setClaim] = useState<Claim | null>(null);
  const [approved, setApproved] = useState(false);
  const [label, setLabel] = useState(defaultPasskeyLabel());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const doClaim = async (body: { token?: string; code?: string }) => {
    setBusy(true);
    setError('');
    try {
      const c = await post<Claim>('/links/claim', body);
      setClaim(c);
      setApproved(!c.require_approval);
      // The token has done its job; keep it out of history.
      if (token) history.replaceState(null, '', '/link');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (token && !claim) void doClaim({ token });
  }, [token]);

  // Waiting for approval: poll every 2 s.
  useEffect(() => {
    if (!claim || approved) return;
    const id = setInterval(async () => {
      try {
        const s = await post<{ approved: boolean }>('/links/claim/status', { claim: claim.claim });
        if (s.approved) setApproved(true);
      } catch (err) {
        setError(errorText(err));
        clearInterval(id);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [claim, approved]);

  return (
    <section class="panel stack" aria-labelledby="nd-title">
      <h1 id="nd-title" tabIndex={-1}>
        {t('link.newDeviceTitle')}
      </h1>
      <Unsupported />
      <ErrorLine text={error} />
      {!claim && !token && (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void doClaim({ code });
          }}
        >
          <p>{t('link.enterCodeIntro')}</p>
          <div class="field">
            <label for="lc">{t('link.code')}</label>
            <input
              id="lc"
              class="code-big"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellcheck={false}
              placeholder="XXXX-XXXX"
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
              required
            />
          </div>
          <button type="submit" class="btn primary" disabled={busy}>
            {t('link.continue')}
          </button>
        </form>
      )}
      {claim && !approved && (
        <div class="stack" aria-live="polite">
          <p>{t('link.pickThisNumber')}</p>
          <p class="approval-number">{claim.approval_number}</p>
          <p class="muted">{t('link.waiting')}</p>
        </div>
      )}
      {claim && approved && (
        <form
          class="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await registerViaLink(claim.claim, label.trim());
              await loadAuth();
              navigate('/', true);
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>{t('link.readyIntro', { name: claim.display_name })}</p>
          <div class="field">
            <label for="nd-label">{t('auth.passkeyLabel')}</label>
            <input
              id="nd-label"
              value={label}
              maxLength={100}
              required
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
          </div>
          <button type="submit" class="btn primary" disabled={busy}>
            {t('auth.createPasskey')}
          </button>
        </form>
      )}
      <p>
        <a href="/">{t('auth.backToLogin')}</a>
      </p>
    </section>
  );
}
