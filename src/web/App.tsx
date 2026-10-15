// SPDX-License-Identifier: AGPL-3.0-or-later
/** App shell: auth gating, header, navigation, routes. */
import { useEffect, useState } from 'preact/hooks';
import { DialogHost } from './components/Dialog';
import { DoneDialogHost } from './components/DoneDialog';
import { Footer } from './components/Footer';
import { Icon, type IconName } from './components/Icons';
import { NoticeBanners } from './components/Notices';
import { showError, ToastHost } from './components/Toast';
import { dismissFailed, failedOps, pendingCount, startData } from './lib/data';
import { dateTime } from './lib/fmt';
import { setLocale, t } from './lib/i18n';
import { navigate, onLinkClick, route } from './lib/router';
import { auth, loadAuth, loadNotices, loadSettings, online, settings } from './lib/store';
import { AdminScreen } from './screens/Admin';
import { Login, MustRegister, NewDevice, Signup } from './screens/Auth';
import { HomeScreen } from './screens/Home';
import { ItemScreen, NewItemScreen } from './screens/Item';
import { ListSettingsScreen } from './screens/ListSettings';
import { ListScreen, ListsScreen } from './screens/Lists';
import { SettingsScreen } from './screens/Settings';

interface NavItem {
  href: string;
  key: string;
  icon: IconName;
}

const isCurrent = (href: string, path: string) =>
  href === '/'
    ? path === '/'
    : href === '/lists'
      ? path.startsWith('/lists') || path.startsWith('/items')
      : path.startsWith(href);

function Header() {
  const path = route.value;
  const nav: NavItem[] = [
    { href: '/', key: 'nav.home', icon: 'sun' },
    { href: '/lists', key: 'nav.lists', icon: 'lists' },
    { href: '/settings', key: 'nav.settings', icon: 'settings' },
  ];
  if (auth.value?.user?.role === 'admin')
    nav.push({ href: '/admin', key: 'nav.admin', icon: 'admin' });
  return (
    <header class="header">
      <a class="brand" href="/">
        <span class="brand-sun" aria-hidden="true" />
        <span>{t('app.name')}</span>
      </a>
      <nav class="nav" aria-label={t('nav.label')}>
        <ul>
          {nav.map((n) => (
            <li key={n.href}>
              <a href={n.href} aria-current={isCurrent(n.href, path) ? 'page' : undefined}>
                <Icon name={n.icon} />
                <span>{t(n.key)}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

function Routes() {
  const path = route.value;
  if (path.startsWith('/settings')) return <SettingsScreen />;
  if (/^\/lists\/[^/]+\/settings$/.test(path)) return <ListSettingsScreen />;
  if (path.startsWith('/lists/')) return <ListScreen />;
  if (path === '/lists') return <ListsScreen />;
  if (path === '/items/new') return <NewItemScreen />;
  if (path.startsWith('/items/')) return <ItemScreen />;
  if (path.startsWith('/admin')) return <AdminScreen />;
  return <HomeScreen />;
}

/** Offline queue status (§6): pending writes and rejected replays, never silent. */
function SyncStatus() {
  return (
    <>
      {pendingCount.value > 0 && (
        <p class="banner" role="status">
          {t('sync.pending', { count: pendingCount.value })}
        </p>
      )}
      {failedOps.value.map((f) => (
        <div class="sync-problem" role="alert" key={f.op_id}>
          <span>
            {t('sync.failed', {
              time: dateTime(new Date(f.queued_at).toISOString()),
              message: f.message || f.error,
            })}
          </span>
          <button type="button" class="btn plain small" onClick={() => void dismissFailed(f.op_id)}>
            {t('sync.dismiss')}
          </button>
        </div>
      ))}
    </>
  );
}

function Shell({ children, bare = false }: { children: preact.ComponentChildren; bare?: boolean }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegated handler for <a> clicks; links are keyboard-activated natively and their click events bubble here.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above, this only intercepts same-origin link navigation.
    <div class="app" onClick={onLinkClick}>
      <a class="skip" href="#main">
        {t('app.skip')}
      </a>
      {!bare && <Header />}
      {!online.value && (
        <p class="banner" role="status">
          {t('app.offline')}
        </p>
      )}
      {!bare && <NoticeBanners />}
      {!bare && <SyncStatus />}
      <main id="main" class={bare ? 'main narrow' : 'main'}>
        {children}
      </main>
      <Footer />
      <DialogHost />
      <DoneDialogHost />
      <ToastHost />
    </div>
  );
}

/** Pages that work without (or regardless of) a session. */
function publicScreen(path: string) {
  if (path === '/setup' || path === '/signup') return <Signup />;
  if (path === '/link' || path.startsWith('/link/')) return <NewDevice />;
  return null;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadAuth()
      .catch(showError)
      .finally(() => setReady(true));
  }, []);

  const a = auth.value;
  const authed = !!a?.authenticated && !a.must_register;
  useEffect(() => {
    if (!authed) return;
    setLoaded(false);
    Promise.all([loadSettings(), loadNotices()])
      .then(() => settings.value && setLocale(settings.value.locale))
      .then(() => setLoaded(true))
      .catch(showError);
    // Local data shows at once (even offline) and syncs in the background.
    if (a?.user) void startData(a.user.id).catch(showError);
  }, [authed]);

  if (!ready || !a) return <Shell bare>{<p>{t('app.loading')}</p>}</Shell>;
  const path = route.value;
  const pub = publicScreen(path);
  if (pub && !authed) return <Shell bare>{pub}</Shell>;
  if (!a.authenticated) {
    if (a.setup_available && path === '/') navigate('/setup', true);
    return <Shell bare>{<Login />}</Shell>;
  }
  if (a.must_register) return <Shell bare>{<MustRegister />}</Shell>;
  if (!loaded) return <Shell bare>{<p>{t('app.loading')}</p>}</Shell>;
  if (pub) navigate('/', true);
  return (
    <Shell>
      <Routes />
    </Shell>
  );
}
