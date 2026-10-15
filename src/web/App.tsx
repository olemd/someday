// SPDX-License-Identifier: AGPL-3.0-or-later
/** App shell: auth gating, header, navigation, routes. */
import { useEffect, useState } from 'preact/hooks';
import { DialogHost } from './components/Dialog';
import { Footer } from './components/Footer';
import { Icon, type IconName } from './components/Icons';
import { NoticeBanners } from './components/Notices';
import { showError, ToastHost } from './components/Toast';
import { setLocale, t } from './lib/i18n';
import { navigate, onLinkClick, route } from './lib/router';
import { auth, loadAuth, loadNotices, loadSettings, online, settings } from './lib/store';
import { AdminScreen } from './screens/Admin';
import { Login, MustRegister, NewDevice, Signup } from './screens/Auth';
import { HomeScreen } from './screens/Home';
import { SettingsScreen } from './screens/Settings';

interface NavItem {
  href: string;
  key: string;
  icon: IconName;
}

const isCurrent = (href: string, path: string) =>
  href === '/' ? path === '/' : path.startsWith(href);

function Header() {
  const path = route.value;
  const nav: NavItem[] = [
    { href: '/', key: 'nav.home', icon: 'sun' },
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
  if (path.startsWith('/admin')) return <AdminScreen />;
  return <HomeScreen />;
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
      <main id="main" class={bare ? 'main narrow' : 'main'}>
        {children}
      </main>
      <Footer />
      <DialogHost />
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
