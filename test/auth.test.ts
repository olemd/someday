// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  authed,
  call,
  createUser,
  DAY,
  db,
  harness,
  loginAs,
  MIN,
  ORIGIN,
  resetDb,
  type Harness,
} from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

const BOOTSTRAP = 'test-bootstrap-token-0123456789';
const newKey = () => new SoftAuthenticator('someday.test', ORIGIN).init();

async function signup(
  h: Harness,
  key: SoftAuthenticator,
  kind: 'setup' | 'invite' | 'open',
  token?: string,
  name = 'Kari',
) {
  const opts = await h.json('/api/auth/signup/options', {
    method: 'POST',
    json: { kind, token, display_name: name },
  });
  if (opts.status !== 200) return opts;
  return h.json('/api/auth/signup/verify', {
    method: 'POST',
    json: {
      label: 'Laptop',
      timezone: 'Europe/Oslo',
      locale: 'nb',
      response: await key.register(opts.body),
    },
  });
}

async function login(h: Harness, key: SoftAuthenticator) {
  const opts = await h.json('/api/auth/login/options', { method: 'POST' });
  return h.json('/api/auth/login/verify', {
    method: 'POST',
    json: { response: await key.assert(opts.body) },
  });
}

async function reauth(h: Harness, key: SoftAuthenticator) {
  const opts = await h.json('/api/auth/reauth/options', { method: 'POST' });
  return h.json('/api/auth/reauth/verify', {
    method: 'POST',
    json: { response: await key.assert(opts.body) },
  });
}

beforeEach(resetDb);

describe('bootstrap admin', () => {
  it('offers setup while no admin exists', async () => {
    const { body } = await harness().json('/api/auth/status');
    expect(body).toMatchObject({
      authenticated: false,
      setup_available: true,
      registration_mode: 'invite',
    });
  });

  it('creates the first admin with a default list, settings and recovery codes', async () => {
    const h = harness();
    const r = await signup(h, await newKey(), 'setup', BOOTSTRAP);
    expect(r.status).toBe(200);
    expect(r.body.recovery_codes).toHaveLength(10);
    expect(r.body.recovery_codes[0]).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
    const status = await h.json('/api/auth/status');
    expect(status.body).toMatchObject({
      authenticated: true,
      setup_available: false,
      user: { display_name: 'Kari', role: 'admin' },
    });
    const lists = await db.all<{ name: string; role: string }>(
      'SELECT l.name, m.role FROM lists l JOIN list_members m ON m.list_id = l.id',
    );
    expect(lists).toEqual([{ name: 'Someday', role: 'owner' }]);
    const settings = await h.json('/api/settings');
    expect(settings.body).toMatchObject({ timezone: 'Europe/Oslo', locale: 'nb' });
  });

  it('rejects a wrong token and disables setup once an admin exists', async () => {
    const h = harness();
    expect((await signup(h, await newKey(), 'setup', 'wrong-token-wrong-token')).body.error).toBe(
      'bad_setup_token',
    );
    expect((await signup(h, await newKey(), 'setup', BOOTSTRAP)).status).toBe(200);
    const again = await signup(harness(), await newKey(), 'setup', BOOTSTRAP);
    expect(again.body.error).toBe('setup_disabled');
  });

  it('lets only one of two concurrent setups win', async () => {
    const [a, b] = [harness(), harness()];
    const [ka, kb] = [await newKey(), await newKey()];
    const optsA = await a.json('/api/auth/signup/options', {
      method: 'POST',
      json: { kind: 'setup', token: BOOTSTRAP, display_name: 'A' },
    });
    const optsB = await b.json('/api/auth/signup/options', {
      method: 'POST',
      json: { kind: 'setup', token: BOOTSTRAP, display_name: 'B' },
    });
    const ra = await a.json('/api/auth/signup/verify', {
      method: 'POST',
      json: { response: await ka.register(optsA.body) },
    });
    const rb = await b.json('/api/auth/signup/verify', {
      method: 'POST',
      json: { response: await kb.register(optsB.body) },
    });
    expect([ra.status, rb.status].sort()).toEqual([200, 403]);
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n).toBe(1);
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys'))!.n).toBe(1);
  });

  it('rate limits signup attempts per IP', async () => {
    const h = harness({ env: { AUTH_RATE_LIMIT: '3' } });
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.json('/api/auth/signup/options', {
        method: 'POST',
        headers,
        json: { kind: 'setup', token: `guess-guess-guess-${i}`, display_name: 'x' },
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([403, 403, 403, 429]);
  });
});

describe('invites and registration modes', () => {
  it('signs up with a single-use invite', async () => {
    const inviter = await authed();
    const inv = await call(inviter, 'POST', '/api/invites', undefined, 200);
    const token = new URL(inv.url).searchParams.get('invite')!;
    expect((await harness().json(`/api/invites/check?token=${token}`)).body.valid).toBe(true);

    const h = harness();
    expect((await signup(h, await newKey(), 'invite', token, 'Ola')).status).toBe(200);
    expect((await h.json('/api/auth/status')).body.user).toMatchObject({
      display_name: 'Ola',
      role: 'user',
    });
    const reuse = await signup(harness(), await newKey(), 'invite', token);
    expect(reuse.body.error).toBe('bad_invite');
    const list = await call(inviter, 'GET', '/api/invites');
    expect(list[0]).toMatchObject({ used_by_name: 'Ola' });
  });

  it('expires invites', async () => {
    const inviter = await authed();
    const inv = await call(inviter, 'POST', '/api/invites', undefined, 200);
    const token = new URL(inv.url).searchParams.get('invite')!;
    const h = harness({ now: inviter.clock.now() + 8 * DAY });
    expect((await signup(h, await newKey(), 'invite', token)).body.error).toBe('bad_invite');
  });

  it('restricts invite creation to admins when configured', async () => {
    const env = { INVITES_ADMIN_ONLY: 'true' };
    const user = await authed({ env });
    expect((await user.json('/api/invites', { method: 'POST' })).status).toBe(403);
    const admin = await authed({ env, role: 'admin' });
    expect((await admin.json('/api/invites', { method: 'POST' })).status).toBe(200);
  });

  it('requires an invite unless registration is open; closed blocks everything', async () => {
    expect((await signup(harness(), await newKey(), 'open')).body.error).toBe('invite_required');
    const admin = await authed({ role: 'admin' });
    await call(admin, 'PATCH', '/api/admin/settings', { registration_mode: 'open' }, 200);
    expect((await signup(harness(), await newKey(), 'open')).status).toBe(200);

    await call(admin, 'PATCH', '/api/admin/settings', { registration_mode: 'closed' }, 200);
    expect((await signup(harness(), await newKey(), 'open')).body.error).toBe(
      'registration_closed',
    );
    expect((await admin.json('/api/invites', { method: 'POST' })).status).toBe(403);
  });

  it('limits open registrations per IP per hour', async () => {
    const h0 = harness({ env: { REGISTRATION_MODE: 'open', OPEN_REGISTRATIONS_PER_HOUR: '2' } });
    const results = [];
    for (let i = 0; i < 3; i++) {
      const h = harness({
        clock: h0.clock,
        env: { REGISTRATION_MODE: 'open', OPEN_REGISTRATIONS_PER_HOUR: '2' },
      });
      const opts = await h.json('/api/auth/signup/options', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.1' },
        json: { kind: 'open', display_name: `u${i}` },
      });
      const r = await h.json('/api/auth/signup/verify', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.1' },
        json: { response: await (await newKey()).register(opts.body) },
      });
      results.push(r.status);
    }
    expect(results).toEqual([200, 200, 429]);
  });
});

describe('login, re-auth and sessions', () => {
  it('logs in with a discoverable passkey and sets a Lax session cookie', async () => {
    const key = await newKey();
    await signup(harness(), key, 'setup', BOOTSTRAP);
    const h = harness();
    const opts = await h.json('/api/auth/login/options', { method: 'POST' });
    const res = await h.fetch('/api/auth/login/verify', {
      method: 'POST',
      json: { response: await key.assert(opts.body) },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/__Host-session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect((await h.json('/api/auth/status')).body.authenticated).toBe(true);
  });

  it('rejects unknown passkeys and challenge replay', async () => {
    const key = await newKey();
    await signup(harness(), key, 'setup', BOOTSTRAP);
    const h = harness();
    expect((await login(h, await newKey())).body.error).toBe('unknown_passkey');
    const opts = await h.json('/api/auth/login/options', { method: 'POST' });
    const assertion = await key.assert(opts.body);
    expect(
      (await h.json('/api/auth/login/verify', { method: 'POST', json: { response: assertion } }))
        .status,
    ).toBe(200);
    expect(
      (await h.json('/api/auth/login/verify', { method: 'POST', json: { response: assertion } }))
        .status,
    ).toBe(401);
  });

  it('slides the session expiry and expires idle sessions', async () => {
    const h = await authed();
    h.clock.advance(80 * DAY);
    expect((await h.json('/api/settings')).status).toBe(200);
    h.clock.advance(80 * DAY); // 160 days since login, 80 since last use
    expect((await h.json('/api/settings')).status).toBe(200);
    h.clock.advance(91 * DAY);
    expect((await h.json('/api/settings')).status).toBe(401);
  });

  it('requires a fresh passkey assertion for new recovery codes', async () => {
    const key = await newKey();
    const h = harness();
    await signup(h, key, 'setup', BOOTSTRAP);
    h.clock.advance(6 * MIN);
    expect((await h.json('/api/auth/recovery-codes', { method: 'POST' })).body.error).toBe(
      'reauth_required',
    );
    expect((await reauth(h, key)).status).toBe(200);
    const r = await call(h, 'POST', '/api/auth/recovery-codes', undefined, 200);
    expect(r.recovery_codes).toHaveLength(10);
    expect((await call(h, 'GET', '/api/auth/recovery-codes')).remaining).toBe(10);
  });

  it('lists and revokes sessions', async () => {
    const h = await authed();
    const other = harness({ clock: h.clock });
    await loginAs(other, h.userId!);
    const list = await call(h, 'GET', '/api/auth/sessions');
    expect(list).toHaveLength(2);
    const notMine = list.find((s: { current: boolean }) => !s.current);
    await call(h, 'DELETE', `/api/auth/sessions/${notMine.id}`, undefined, 200);
    expect((await other.json('/api/settings')).status).toBe(401);
    expect((await h.json('/api/settings')).status).toBe(200);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const h = await authed();
    const r = await h.json('/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
  });
});

describe('recovery codes', () => {
  it('keep working after RECOVERY_PBKDF2_ITERATIONS changes', async () => {
    const r = await signup(harness(), await newKey(), 'setup', BOOTSTRAP);
    const [first, second]: string[] = r.body.recovery_codes;
    const changed = harness({ env: { RECOVERY_PBKDF2_ITERATIONS: '3000' } });
    expect(
      (await changed.json('/api/auth/recovery', { method: 'POST', json: { code: first } })).status,
    ).toBe(200);
    // Codes from before migration 0005 have no stored count and use the configured one.
    await db.run('UPDATE recovery_codes SET iterations = NULL');
    expect(
      (await harness().json('/api/auth/recovery', { method: 'POST', json: { code: second } }))
        .status,
    ).toBe(200);
  });

  it('logs in once and only allows registering a new passkey', async () => {
    const h0 = harness();
    const r = await signup(h0, await newKey(), 'setup', BOOTSTRAP);
    const code: string = r.body.recovery_codes[3];

    const h = harness();
    expect(
      (
        await h.json('/api/auth/recovery', {
          method: 'POST',
          json: { code: code.toLowerCase().replace(/-/g, ' ') },
        })
      ).status,
    ).toBe(200);
    expect((await h.json('/api/settings')).body.error).toBe('must_register');
    const key = await newKey();
    const opts = await h.json('/api/auth/register/options', { method: 'POST' });
    expect(opts.status).toBe(200);
    await call(
      h,
      'POST',
      '/api/auth/register/verify',
      { response: await key.register(opts.body), label: 'Phone' },
      200,
    );
    expect((await h.json('/api/settings')).status).toBe(200);
    // A code works once.
    const again = await harness().json('/api/auth/recovery', { method: 'POST', json: { code } });
    expect(again.body.error).toBe('bad_recovery_code');
    // The new passkey triggered a notice for the user's other sessions.
    expect((await call(h0, 'GET', '/api/notices'))[0]).toMatchObject({
      kind: 'passkey_added',
      data: { label: 'Phone' },
    });
  });
});

describe('passkey management', () => {
  it('never deletes the last passkey; deleting one revokes its sessions', async () => {
    const key = await newKey();
    const h = harness();
    await signup(h, key, 'setup', BOOTSTRAP);
    const [pk] = await call(h, 'GET', '/api/auth/passkeys');
    expect(pk.current).toBe(true);
    expect((await h.json(`/api/auth/passkeys/${pk.id}`, { method: 'DELETE' })).body.error).toBe(
      'last_passkey',
    );

    // Add a second passkey (needs a fresh assertion: signup counts).
    const key2 = await newKey();
    const opts = await h.json('/api/auth/register/options', { method: 'POST' });
    await call(
      h,
      'POST',
      '/api/auth/register/verify',
      { response: await key2.register(opts.body), label: 'Tablet' },
      200,
    );
    const h2 = harness({ clock: h.clock });
    await login(h2, key2);
    const tablet = (await call(h, 'GET', '/api/auth/passkeys')).find(
      (p: { label: string }) => p.label === 'Tablet',
    );
    await call(h, 'PATCH', `/api/auth/passkeys/${tablet.id}`, { label: 'Old tablet' }, 200);
    await call(h, 'DELETE', `/api/auth/passkeys/${tablet.id}`, undefined, 200);
    expect((await h2.json('/api/settings')).status).toBe(401);
    expect((await h.json('/api/settings')).status).toBe(200);
  });

  it('requires fresh auth to add a passkey from settings', async () => {
    const h = await authed();
    expect((await h.json('/api/auth/register/options', { method: 'POST' })).body.error).toBe(
      'reauth_required',
    );
  });
});

describe('admin', () => {
  it('lists users, disables them (logging them out) and shows stats', async () => {
    const admin = await authed({ role: 'admin' });
    const user = await otherAuthed(admin);
    expect((await user.json('/api/admin/users')).status).toBe(403);
    const users = await call(admin, 'GET', '/api/admin/users');
    expect(users).toHaveLength(2);
    await call(admin, 'POST', `/api/admin/users/${user.userId}/disable`, undefined, 200);
    expect((await user.json('/api/settings')).status).toBe(401);
    expect(
      (await admin.json(`/api/admin/users/${admin.userId}/disable`, { method: 'POST' })).status,
    ).toBe(409);
    expect(await call(admin, 'GET', '/api/admin/stats')).toMatchObject({ users: 2, lists: 2 });
    await call(admin, 'POST', `/api/admin/users/${user.userId}/enable`, undefined, 200);
  });

  it('a disabled user cannot log in', async () => {
    const key = await newKey();
    await signup(harness(), key, 'setup', BOOTSTRAP);
    await db.run("UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z'");
    expect((await login(harness(), key)).body.error).toBe('account_disabled');
  });
});

async function otherAuthed(h: Harness) {
  const u = await createUser(h.ctx, { name: 'User' });
  return loginAs(harness({ clock: h.clock }), u.id);
}
