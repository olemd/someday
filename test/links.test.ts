// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { authed, call, db, harness, MIN, ORIGIN, resetDb, type Harness } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

const newKey = () => new SoftAuthenticator('someday.test', ORIGIN).init();

beforeEach(resetDb);

async function createLink(h: Harness) {
  return call(h, 'POST', '/api/links', undefined, 200);
}

/** The new device: claim, register a passkey, end with a session. */
async function completeOnNewDevice(dev: Harness, claim: string, label = 'Firefox on Linux') {
  const opts = await dev.json('/api/links/claim/options', { method: 'POST', json: { claim } });
  if (opts.status !== 200) return opts;
  const key = await newKey();
  return dev.json('/api/links/claim/verify', {
    method: 'POST',
    json: { claim, label, response: await key.register(opts.body) },
  });
}

describe('device links', () => {
  it('needs a fresh passkey assertion to create', async () => {
    const h = await authed({ fresh: false });
    expect((await h.json('/api/links', { method: 'POST' })).body.error).toBe('reauth_required');
    const fresh = await authed({ fresh: true });
    fresh.clock.advance(6 * MIN);
    expect((await fresh.json('/api/links', { method: 'POST' })).body.error).toBe('reauth_required');
  });

  it('adds a passkey on a new device via the link token, then is used up', async () => {
    const h = await authed({ fresh: true });
    const link = await createLink(h);
    expect(link.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(link.url).toMatch(`${ORIGIN}/link/`);
    const token = link.url.split('/link/')[1];

    const dev = harness({ clock: h.clock });
    const claim = await call(dev, 'POST', '/api/links/claim', { token }, 200);
    expect(claim).toMatchObject({ display_name: 'Test User', require_approval: false });
    // An abandoned ceremony leaves the link valid: options twice is fine.
    await call(dev, 'POST', '/api/links/claim/options', { claim: claim.claim }, 200);
    const r = await completeOnNewDevice(dev, claim.claim);
    expect(r.status).toBe(200);
    expect((await dev.json('/api/auth/status')).body.user.id).toBe(h.userId);

    const passkeys = await db.all('SELECT label FROM passkeys WHERE user_id = ?', h.userId);
    expect(passkeys).toEqual([{ label: 'Firefox on Linux' }]);
    // Other sessions see the notice.
    expect((await call(h, 'GET', '/api/notices'))[0]).toMatchObject({ kind: 'passkey_added' });
    // Single use.
    expect(
      (await harness().json('/api/links/claim', { method: 'POST', json: { token } })).status,
    ).toBe(404);
  });

  it('accepts the short code, case- and separator-insensitively', async () => {
    const h = await authed({ fresh: true });
    const link = await createLink(h);
    const typed = link.code.toLowerCase().replace('-', ' ');
    const dev = harness({ clock: h.clock });
    const claim = await call(dev, 'POST', '/api/links/claim', { code: typed }, 200);
    expect((await completeOnNewDevice(dev, claim.claim)).status).toBe(200);
  });

  it('invalidates the code after 5 wrong attempts', async () => {
    const h = await authed({ fresh: true });
    const link = await createLink(h);
    const code: string = link.code.replace('-', '');
    const wrong = `${code.slice(0, 3)}${code[3] === '0' ? '1' : '0'}${code.slice(4)}`;
    const dev = harness({ clock: h.clock });
    for (let i = 0; i < 5; i++) {
      expect(
        (await dev.json('/api/links/claim', { method: 'POST', json: { code: wrong } })).status,
      ).toBe(404);
    }
    expect((await dev.json('/api/links/claim', { method: 'POST', json: { code } })).status).toBe(
      404,
    );
  });

  it('expires after DEVICE_LINK_TTL_MIN and caps active links at 3', async () => {
    const h = await authed({ fresh: true });
    const link = await createLink(h);
    await createLink(h);
    await createLink(h);
    expect((await h.json('/api/links', { method: 'POST' })).body.error).toBe('too_many_links');
    const token = link.url.split('/link/')[1];
    h.clock.advance(16 * MIN);
    expect(
      (
        await harness({ clock: h.clock }).json('/api/links/claim', {
          method: 'POST',
          json: { token },
        })
      ).status,
    ).toBe(404);
  });

  it('with approval: waits for the originating device to pick the number', async () => {
    const h = await authed({ fresh: true });
    await call(h, 'PATCH', '/api/settings', { require_link_approval: true }, 200);
    const link = await createLink(h);
    expect(link.require_approval).toBe(true);
    const dev = harness({ clock: h.clock });
    const claim = await call(
      dev,
      'POST',
      '/api/links/claim',
      { token: link.url.split('/link/')[1] },
      200,
    );
    expect(claim.approval_number).toBeGreaterThanOrEqual(10);
    expect((await completeOnNewDevice(dev, claim.claim)).body.error).toBe('approval_pending');

    const [pending] = await call(h, 'GET', '/api/links');
    expect(pending.approval_choices).toHaveLength(3);
    expect(pending.approval_choices).toContain(claim.approval_number);
    await call(
      h,
      'POST',
      `/api/links/${pending.id}/approve`,
      { number: claim.approval_number },
      200,
    );
    expect(
      (await call(dev, 'POST', '/api/links/claim/status', { claim: claim.claim })).approved,
    ).toBe(true);
    expect((await completeOnNewDevice(dev, claim.claim)).status).toBe(200);
  });

  it('a wrong pick cancels the link', async () => {
    const h = await authed({ fresh: true });
    await call(h, 'PATCH', '/api/settings', { require_link_approval: true }, 200);
    const link = await createLink(h);
    const dev = harness({ clock: h.clock });
    const claim = await call(
      dev,
      'POST',
      '/api/links/claim',
      { token: link.url.split('/link/')[1] },
      200,
    );
    const [pending] = await call(h, 'GET', '/api/links');
    const wrong = pending.approval_choices.find((n: number) => n !== claim.approval_number);
    expect(
      (
        await h.json(`/api/links/${pending.id}/approve`, {
          method: 'POST',
          json: { number: wrong },
        })
      ).body.error,
    ).toBe('wrong_number');
    expect((await completeOnNewDevice(dev, claim.claim)).status).toBe(410);
  });

  it('"That wasn\'t me" revokes the new passkey and its sessions', async () => {
    const h = await authed({ fresh: true });
    const link = await createLink(h);
    const dev = harness({ clock: h.clock });
    const claim = await call(
      dev,
      'POST',
      '/api/links/claim',
      { token: link.url.split('/link/')[1] },
      200,
    );
    await completeOnNewDevice(dev, claim.claim);
    const [notice] = await call(h, 'GET', '/api/notices');
    // The test user was created without a passkey, so add one to keep >1.
    await db.run(
      `INSERT INTO passkeys (id, user_id, public_key, label, created_at) VALUES ('own', ?, x'00', 'Own', '2026-01-01')`,
      h.userId,
    );
    await call(h, 'DELETE', `/api/auth/passkeys/${notice.data.passkey_id}`, undefined, 200);
    expect((await dev.json('/api/settings')).status).toBe(401);
  });

  it('rate limits claims per IP', async () => {
    const dev = harness({ env: { AUTH_RATE_LIMIT: '2' } });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (
          await dev.json('/api/links/claim', {
            method: 'POST',
            headers: { 'cf-connecting-ip': '192.0.2.7' },
            json: { code: 'AAAA-AAAA' },
          })
        ).status,
      );
    }
    expect(statuses).toEqual([404, 404, 429]);
  });
});
