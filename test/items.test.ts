// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { iso } from '../src/core/ports';
import { authed, call, DAY, db, HOUR, otherUser, resetDb, type Harness } from './helpers';

beforeEach(resetDb);

type H = Harness & { user: { id: string; defaultListId: string } };

async function addMember(listId: string, userId: string, role = 'editor') {
  await db.run(
    'INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    listId,
    userId,
    role,
    iso(Date.now()),
  );
}

async function newItem(h: H, fields: Record<string, unknown> = {}) {
  return call(
    h,
    'POST',
    '/api/items',
    { list_id: h.user.defaultListId, title: 'Aurora', ...fields },
    201,
  );
}

describe('lists', () => {
  it('every user starts with a private "Someday" list', async () => {
    const h = (await authed()) as H;
    const lists = await call(h, 'GET', '/api/lists');
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      name: 'Someday',
      role: 'owner',
      member_count: 1,
      include_in_suggestions: true,
      anonymous_available: false,
    });
  });

  it('creates, renames, soft-deletes and restores lists; never the last one', async () => {
    const h = (await authed()) as H;
    const l = await call(h, 'POST', '/api/lists', { name: 'Learn about' }, 201);
    await call(h, 'PATCH', `/api/lists/${l.id}`, { name: 'Find out about' }, 200);
    expect((await call(h, 'GET', `/api/lists/${l.id}`)).name).toBe('Find out about');
    await call(h, 'DELETE', `/api/lists/${l.id}`, undefined, 200);
    expect(await call(h, 'GET', '/api/lists')).toHaveLength(1);
    expect((await call(h, 'GET', '/api/lists/deleted'))[0].id).toBe(l.id);
    await call(h, 'POST', `/api/lists/${l.id}/restore`, undefined, 200);
    expect(await call(h, 'GET', '/api/lists')).toHaveLength(2);
    await call(h, 'DELETE', `/api/lists/${l.id}`, undefined, 200);
    expect(
      (await h.json(`/api/lists/${h.user.defaultListId}`, { method: 'DELETE' })).body.error,
    ).toBe('last_list');
  });

  it('purges soft-deleted lists after the grace period', async () => {
    const h = (await authed()) as H;
    const l = await call(h, 'POST', '/api/lists', { name: 'Temp' }, 201);
    await call(h, 'POST', '/api/items', { list_id: l.id, title: 'x' }, 201);
    await call(h, 'DELETE', `/api/lists/${l.id}`, undefined, 200);
    h.clock.advance(31 * DAY);
    const { listsModule } = await import('../src/modules/lists');
    await listsModule.cron!(h.ctx);
    expect(await db.first('SELECT 1 FROM lists WHERE id = ?', l.id)).toBeNull();
    expect(await db.first('SELECT 1 FROM items WHERE list_id = ?', l.id)).toBeNull();
  });
});

describe('items', () => {
  it('creates an item with all context fields and normalised tags', async () => {
    const h = (await authed()) as H;
    const item = await newItem(h, {
      notes: 'Go north',
      duration: 'trip',
      setting: 'outdoor',
      cost: 2,
      energy: 'medium',
      social: 'together',
      valid_to: '2030-01-01',
      months: 0b111000000111, // Sep–Mar
      links: [{ url: 'https://example.com/aurora', label: 'Forecast' }],
      location: { label: 'Tromsø', lat: 69.65, lon: 18.96 },
      tags: ['Nature', ' night ', 'nature'],
    });
    expect(item).toMatchObject({
      title: 'Aurora',
      status: 'idea',
      repeatable: false,
      duration: 'trip',
      tags: ['nature', 'night'],
      done_for_me: false,
      done_count: null,
      location: { label: 'Tromsø' },
    });
    expect(await call(h, 'GET', '/api/tags')).toEqual([
      { tag: 'nature', count: 1 },
      { tag: 'night', count: 1 },
    ]);
  });

  it('validates input', async () => {
    const h = (await authed()) as H;
    expect(
      (
        await h.json('/api/items', {
          method: 'POST',
          json: { list_id: h.user.defaultListId, title: '' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.json('/api/items', {
          method: 'POST',
          json: {
            list_id: h.user.defaultListId,
            title: 'x',
            valid_from: '2030-01-02',
            valid_to: '2030-01-01',
          },
        })
      ).body.error,
    ).toBe('bad_window');
    expect(
      (
        await h.json('/api/items', {
          method: 'POST',
          json: {
            list_id: h.user.defaultListId,
            title: 'x',
            links: [{ url: 'javascript:alert(1)' }],
          },
        })
      ).status,
    ).toBe(400);
  });

  it('updates, searches, filters and deletes', async () => {
    const h = (await authed()) as H;
    const a = await newItem(h, { title: 'See the aurora', tags: ['nature'] });
    await newItem(h, { title: 'Learn Rust', notes: 'the borrow checker', tags: ['learn'] });
    await call(
      h,
      'PATCH',
      `/api/items/${a.id}`,
      { status: 'planned', tags: ['nature', 'trip'] },
      200,
    );
    expect(
      (await call(h, 'GET', '/api/items?q=BORROW')).map((i: { title: string }) => i.title),
    ).toEqual(['Learn Rust']);
    expect((await call(h, 'GET', '/api/items?tag=trip')).map((i: { id: string }) => i.id)).toEqual([
      a.id,
    ]);
    expect(await call(h, 'GET', '/api/items?status=planned')).toHaveLength(1);
    expect(await call(h, 'GET', '/api/items?q=50%25')).toHaveLength(0);
    await call(h, 'DELETE', `/api/items/${a.id}`, undefined, 200);
    expect(await call(h, 'GET', '/api/items')).toHaveLength(1);
  });

  it('moves items between lists the user can edit', async () => {
    const h = (await authed()) as H;
    const other = await call(h, 'POST', '/api/lists', { name: 'Other' }, 201);
    const a = await newItem(h);
    await call(h, 'PATCH', `/api/items/${a.id}`, { list_id: other.id }, 200);
    expect((await call(h, 'GET', `/api/items/${a.id}`)).item.list_id).toBe(other.id);
    const stranger = (await otherUser(h)) as H;
    const r = await h.json(`/api/items/${a.id}`, {
      method: 'PATCH',
      json: { list_id: stranger.user.defaultListId },
    });
    expect(r.status).toBe(404);
  });

  it('resolves concurrent offline edits last-write-wins per field', async () => {
    const h = (await authed()) as H;
    const a = await newItem(h);
    const t0 = h.clock.now();
    const { writeItem } = await import('../src/modules/items/service');
    const access = { userId: h.userId!, listIds: null };
    const actor = { id: h.userId!, kind: 'user' as const };
    h.clock.advance(HOUR);
    // Device B edited the title 10 minutes after device A edited the notes and title.
    await writeItem(h.ctx, access, actor, {
      kind: 'upsert',
      id: a.id,
      fields: { title: 'B title' },
      ts: t0 + 20 * 60_000,
    });
    const r = await writeItem(h.ctx, access, actor, {
      kind: 'upsert',
      id: a.id,
      fields: { title: 'A title', notes: 'A notes' },
      ts: t0 + 10 * 60_000,
    });
    expect(r.rejected).toEqual(['title']);
    const item = (await call(h, 'GET', `/api/items/${a.id}`)).item;
    expect(item).toMatchObject({ title: 'B title', notes: 'A notes' });
    // A client clock in the future is clamped to server time.
    await writeItem(h.ctx, access, actor, {
      kind: 'upsert',
      id: a.id,
      fields: { title: 'Future' },
      ts: t0 + 365 * DAY,
    });
    h.clock.advance(1000);
    await call(h, 'PATCH', `/api/items/${a.id}`, { title: 'Now' }, 200);
    expect((await call(h, 'GET', `/api/items/${a.id}`)).item.title).toBe('Now');
  });

  it('is idempotent for replayed creates with a client id', async () => {
    const h = (await authed()) as H;
    const id = '01JABCDEFGHJKMNPQRSTVWXYZ0';
    await call(h, 'POST', '/api/items', { id, list_id: h.user.defaultListId, title: 'Once' }, 201);
    await call(h, 'POST', '/api/items', { id, list_id: h.user.defaultListId, title: 'Once' }, 201);
    expect(await call(h, 'GET', '/api/items')).toHaveLength(1);
  });
});

describe('access control', () => {
  it("never shows or changes other users' lists, items or log entries", async () => {
    const a = (await authed({ name: 'A' })) as H;
    const b = (await otherUser(a, 'B')) as H;
    const item = await newItem(a);
    const entry = await call(
      a,
      'POST',
      `/api/items/${item.id}/log`,
      { done_on: '2026-10-01' },
      201,
    );
    expect(await call(b, 'GET', '/api/items')).toEqual([]);
    for (const [method, path, json] of [
      ['GET', `/api/items/${item.id}`, undefined],
      ['PATCH', `/api/items/${item.id}`, { title: 'pwned' }],
      ['DELETE', `/api/items/${item.id}`, undefined],
      ['POST', `/api/items/${item.id}/log`, { done_on: '2026-10-01' }],
      ['GET', `/api/lists/${a.user.defaultListId}`, undefined],
      ['PATCH', `/api/lists/${a.user.defaultListId}`, { name: 'pwned' }],
      ['DELETE', `/api/lists/${a.user.defaultListId}`, undefined],
      ['PATCH', `/api/log/${entry.id}`, { note: 'pwned' }],
      ['DELETE', `/api/log/${entry.id}`, undefined],
      ['POST', '/api/items', { list_id: a.user.defaultListId, title: 'pwned' }],
    ] as const) {
      const r = await b.json(path, { method, ...(json ? { json } : {}) });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect((await call(a, 'GET', `/api/items/${item.id}`)).item.title).toBe('Aurora');
  });

  it('viewers can read and log but not edit', async () => {
    const a = (await authed({ name: 'A' })) as H;
    const v = (await otherUser(a, 'Viewer')) as H;
    await addMember(a.user.defaultListId, v.userId!, 'viewer');
    const item = await newItem(a);
    expect((await call(v, 'GET', `/api/items/${item.id}`)).item.title).toBe('Aurora');
    expect(
      (await v.json(`/api/items/${item.id}`, { method: 'PATCH', json: { title: 'x' } })).status,
    ).toBe(403);
    expect(
      (
        await v.json('/api/items', {
          method: 'POST',
          json: { list_id: a.user.defaultListId, title: 'x' },
        })
      ).status,
    ).toBe(403);
    await call(v, 'POST', `/api/items/${item.id}/log`, { done_on: '2026-10-01' }, 201);
  });
});

describe('done log', () => {
  it('on a private list, done closes a non-repeatable item and undo reopens it', async () => {
    const h = (await authed()) as H;
    const item = await newItem(h, { status: 'planned' });
    const e = await call(
      h,
      'POST',
      `/api/items/${item.id}/log`,
      { done_on: '2026-10-14', note: 'Wow', rating: 5, visibility: 'shared' },
      201,
    );
    expect(e).toMatchObject({ visibility: 'private', mine: true, rating: 5 });
    expect((await call(h, 'GET', `/api/items/${item.id}`)).item).toMatchObject({
      status: 'done',
      done_for_me: true,
      my_last_done_on: '2026-10-14',
    });
    await call(h, 'DELETE', `/api/log/${e.id}`, undefined, 200);
    expect((await call(h, 'GET', `/api/items/${item.id}`)).item).toMatchObject({
      status: 'planned',
      done_for_me: false,
    });
  });

  it('repeatable items stay open after logging', async () => {
    const h = (await authed()) as H;
    const item = await newItem(h, { repeatable: true });
    await call(h, 'POST', `/api/items/${item.id}/log`, { done_on: '2026-10-14' }, 201);
    expect((await call(h, 'GET', `/api/items/${item.id}`)).item).toMatchObject({
      status: 'idea',
      done_for_me: true,
    });
  });

  it('on shared lists, done is per user and visibility is respected', async () => {
    const a = (await authed({ name: 'Ann' })) as H;
    const b = (await otherUser(a, 'Bob')) as H;
    await addMember(a.user.defaultListId, b.userId!);
    const item = await newItem(a);
    // Default visibility on a shared list is private.
    const priv = await call(
      b,
      'POST',
      `/api/items/${item.id}/log`,
      { done_on: '2026-10-01', note: 'secret' },
      201,
    );
    expect(priv.visibility).toBe('private');
    // Status unchanged for everyone; done for Bob only.
    expect((await call(a, 'GET', `/api/items/${item.id}`)).item).toMatchObject({
      status: 'idea',
      done_for_me: false,
      done_by: [],
      done_count: null,
    });
    expect((await call(b, 'GET', `/api/items/${item.id}`)).item.done_for_me).toBe(true);
    // Ann never sees Bob's private entry.
    expect((await call(a, 'GET', `/api/items/${item.id}`)).log).toEqual([]);
    // Two members: anonymous is unavailable (it would identify Bob).
    expect(
      (
        await b.json(`/api/items/${item.id}/log`, {
          method: 'POST',
          json: { done_on: '2026-10-02', visibility: 'anonymous' },
        })
      ).body.error,
    ).toBe('anonymous_unavailable');
    // Shared: listed by name, and remembered as Bob's default for the list.
    await call(b, 'PATCH', `/api/log/${priv.id}`, { visibility: 'shared' }, 200);
    const seen = await call(a, 'GET', `/api/items/${item.id}`);
    expect(seen.item.done_by).toEqual(['Bob']);
    expect(seen.log).toMatchObject([{ user_name: 'Bob', mine: false, note: 'secret' }]);
    // Ann cannot edit Bob's entry.
    expect(
      (await a.json(`/api/log/${priv.id}`, { method: 'PATCH', json: { note: 'x' } })).status,
    ).toBe(404);
    // Open-for-me filter: Bob's done item drops out of his open view only.
    expect(await call(b, 'GET', '/api/items?open_for_me=true')).toEqual([]);
    expect(await call(a, 'GET', '/api/items?open_for_me=true')).toHaveLength(1);
  });

  it('shows an anonymous done-count only at or above the group-size threshold', async () => {
    const a = (await authed({ name: 'A' })) as H;
    const others: H[] = [];
    for (const n of ['B', 'C', 'D']) {
      const o = (await otherUser(a, n)) as H;
      await addMember(a.user.defaultListId, o.userId!);
      others.push(o);
    }
    const item = await newItem(a);
    const [b, c] = others as [H, H];
    await call(
      b,
      'POST',
      `/api/items/${item.id}/log`,
      { done_on: '2026-10-01', visibility: 'anonymous' },
      201,
    );
    await call(
      c,
      'POST',
      `/api/items/${item.id}/log`,
      { done_on: '2026-10-01', visibility: 'shared' },
      201,
    );
    const seen = await call(a, 'GET', `/api/items/${item.id}`);
    expect(seen.item.done_count).toBe(2);
    expect(seen.item.done_by).toEqual(['C']);
    expect(seen.log.map((e: { user_name: string }) => e.user_name)).toEqual(['C']);
    // The owner raises the threshold above the member count: the count disappears.
    await call(
      a,
      'PATCH',
      `/api/lists/${a.user.defaultListId}`,
      { anon_count_min_members: 5 },
      200,
    );
    expect((await call(a, 'GET', `/api/items/${item.id}`)).item.done_count).toBeNull();
    expect(
      (
        await a.json(`/api/lists/${a.user.defaultListId}`, {
          method: 'PATCH',
          json: { anon_count_min_members: 2 },
        })
      ).status,
    ).toBe(400);
  });

  it('an editor can mark an item done for everyone', async () => {
    const a = (await authed({ name: 'A' })) as H;
    const b = (await otherUser(a, 'B')) as H;
    await addMember(a.user.defaultListId, b.userId!);
    const item = await newItem(a);
    await call(b, 'PATCH', `/api/items/${item.id}`, { status: 'archived' }, 200);
    expect((await call(a, 'GET', `/api/items/${item.id}`)).item.status).toBe('archived');
  });
});
