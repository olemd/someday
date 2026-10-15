// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  authed,
  call,
  DAY,
  db,
  harness,
  ORIGIN,
  otherUser,
  resetDb,
  type Harness,
} from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

beforeEach(resetDb);

type H = Harness & { user: { id: string; defaultListId: string } };

const tokenOf = (url: string) => url.split('/join/')[1]!;

async function share(owner: H, role: 'editor' | 'viewer' = 'editor', maxUses = 1) {
  const inv = await call(
    owner,
    'POST',
    `/api/lists/${owner.user.defaultListId}/invites`,
    { role, max_uses: maxUses },
    201,
  );
  return tokenOf(inv.url);
}

describe('list invites', () => {
  it('lets someone join with the chosen role; single use by default', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const b = (await otherUser(a, 'Bob')) as H;
    const c = (await otherUser(a, 'Cid')) as H;
    const token = await share(a, 'viewer');
    expect((await harness().json(`/api/join/${token}`)).body).toEqual({
      list_name: 'Someday',
      inviter: 'Ann',
      role: 'viewer',
    });
    expect(await call(b, 'POST', `/api/join/${token}`, undefined, 200)).toEqual({
      list_id: a.user.defaultListId,
      already_member: false,
    });
    const list = await call(b, 'GET', `/api/lists/${a.user.defaultListId}`);
    expect(list).toMatchObject({ role: 'viewer', member_count: 2 });
    expect((await c.json(`/api/join/${token}`, { method: 'POST' })).body.error).toBe(
      'invite_invalid',
    );
    // Joining twice is harmless.
    expect((await call(b, 'POST', `/api/join/${token}`)).error).toBe('invite_invalid');
  });

  it('expires and can be revoked; only the owner manages invites', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const b = (await otherUser(a, 'Bob')) as H;
    const token = await share(a, 'editor', 5);
    await call(b, 'POST', `/api/join/${token}`, undefined, 200);
    expect(
      (await b.json(`/api/lists/${a.user.defaultListId}/invites`, { method: 'POST', json: {} }))
        .status,
    ).toBe(403);
    const [inv] = await call(a, 'GET', `/api/lists/${a.user.defaultListId}/invites`);
    expect(inv).toMatchObject({ uses: 1, max_uses: 5, revoked: false });
    await call(a, 'DELETE', `/api/lists/${a.user.defaultListId}/invites/${inv.id}`, undefined, 200);
    const c = (await otherUser(a, 'Cid')) as H;
    expect((await c.json(`/api/join/${token}`, { method: 'POST' })).status).toBe(410);
    const t2 = await share(a);
    c.clock.advance(8 * DAY);
    expect((await c.json(`/api/join/${t2}`, { method: 'POST' })).status).toBe(410);
  });

  it('a list invite lets a new person sign up and join in one go', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const token = await share(a);
    const h = harness({ clock: a.clock });
    const key = await new SoftAuthenticator('someday.test', ORIGIN).init();
    const opts = await h.json('/api/auth/signup/options', {
      method: 'POST',
      json: { kind: 'join', token, display_name: 'Dee' },
    });
    expect(opts.status).toBe(200);
    await call(
      h,
      'POST',
      '/api/auth/signup/verify',
      { response: await key.register(opts.body) },
      200,
    );
    const lists = await call(h, 'GET', '/api/lists');
    expect(lists.map((l: { name: string; role: string }) => [l.name, l.role]).sort()).toEqual([
      ['Someday', 'editor'],
      ['Someday', 'owner'],
    ]);
  });
});

describe('members', () => {
  it('changes roles, removes members, lets members leave', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const b = (await otherUser(a, 'Bob')) as H;
    await call(b, 'POST', `/api/join/${await share(a)}`, undefined, 200);
    const listId = a.user.defaultListId;
    await call(a, 'PATCH', `/api/lists/${listId}/members/${b.userId}`, { role: 'viewer' }, 200);
    expect(
      (await b.json('/api/items', { method: 'POST', json: { list_id: listId, title: 'x' } }))
        .status,
    ).toBe(403);
    // Bob cannot remove Ann; Ann cannot leave without transferring.
    expect(
      (await b.json(`/api/lists/${listId}/members/${a.userId}`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect(
      (await a.json(`/api/lists/${listId}/members/${a.userId}`, { method: 'DELETE' })).body.error,
    ).toBe('owner_cannot_leave');
    await call(b, 'DELETE', `/api/lists/${listId}/members/${b.userId}`, undefined, 200);
    expect((await b.json(`/api/lists/${listId}`)).status).toBe(404);
  });

  it('transfers ownership (exactly one owner)', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const b = (await otherUser(a, 'Bob')) as H;
    await call(b, 'POST', `/api/join/${await share(a)}`, undefined, 200);
    const listId = a.user.defaultListId;
    await call(a, 'POST', `/api/lists/${listId}/transfer`, { user_id: b.userId }, 200);
    expect((await call(a, 'GET', `/api/lists/${listId}`)).role).toBe('editor');
    expect((await call(b, 'GET', `/api/lists/${listId}`)).role).toBe('owner');
    const owners = await db.all(
      "SELECT user_id FROM list_members WHERE list_id = ? AND role = 'owner'",
      listId,
    );
    expect(owners).toEqual([{ user_id: b.userId }]);
    // Ann can leave now.
    await call(a, 'DELETE', `/api/lists/${listId}/members/${a.userId}`, undefined, 200);
  });

  it('a removed member gets tombstones on sync', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const b = (await otherUser(a, 'Bob')) as H;
    await call(b, 'POST', `/api/join/${await share(a)}`, undefined, 200);
    const item = await call(
      a,
      'POST',
      '/api/items',
      { list_id: a.user.defaultListId, title: 'X' },
      201,
    );
    const s0 = await call(b, 'GET', '/api/sync?since=0');
    expect(s0.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
    await call(
      a,
      'DELETE',
      `/api/lists/${a.user.defaultListId}/members/${b.userId}`,
      undefined,
      200,
    );
    const s1 = await call(b, 'GET', `/api/sync?since=${s0.cursor}`);
    expect(s1.deleted.lists).toEqual([a.user.defaultListId]);
    expect(s1.deleted.items).toEqual([item.id]);
  });

  it('joining shows the new list and its items on the next incremental sync', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const b = (await otherUser(a, 'Bob')) as H;
    const item = await call(
      a,
      'POST',
      '/api/items',
      { list_id: a.user.defaultListId, title: 'X' },
      201,
    );
    const s0 = await call(b, 'GET', '/api/sync?since=0');
    await call(b, 'POST', `/api/join/${await share(a)}`, undefined, 200);
    const s1 = await call(b, 'GET', `/api/sync?since=${s0.cursor}`);
    expect(s1.lists.map((l: { id: string }) => l.id)).toContain(a.user.defaultListId);
    expect(s1.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
  });
});
