// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { iso } from '../src/core/ports';
import { authed, call, DAY, db, HOUR, otherUser, resetDb, type Harness } from './helpers';

beforeEach(resetDb);

type H = Harness & { user: { id: string; defaultListId: string } };

const sync = (h: H, since: number) => call(h, 'GET', `/api/sync?since=${since}`, undefined, 200);
const push = (h: H, ops: unknown[]) => call(h, 'POST', '/api/sync', { ops }, 200);

async function addMember(listId: string, userId: string) {
  await db.batch([
    {
      sql: "INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
      params: [listId, userId, iso(Date.now())],
    },
    {
      sql: "INSERT INTO changes (entity, entity_id, list_id, op, at) VALUES ('member', ?, ?, 'upsert', ?)",
      params: [userId, listId, iso(Date.now())],
    },
  ]);
}

describe('pull', () => {
  it('starts with a full snapshot, then returns only what changed', async () => {
    const h = (await authed()) as H;
    const a = await call(
      h,
      'POST',
      '/api/items',
      { list_id: h.user.defaultListId, title: 'A' },
      201,
    );
    const s0 = await sync(h, 0);
    expect(s0.full).toBe(true);
    expect(s0.lists).toHaveLength(1);
    expect(s0.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    expect(s0.cursor).toBeGreaterThan(0);

    expect((await sync(h, s0.cursor)).items).toEqual([]);
    const b = await call(
      h,
      'POST',
      '/api/items',
      { list_id: h.user.defaultListId, title: 'B' },
      201,
    );
    await call(h, 'DELETE', `/api/items/${a.id}`, undefined, 200);
    const s1 = await sync(h, s0.cursor);
    expect(s1.full).toBe(false);
    expect(s1.items.map((i: { id: string }) => i.id)).toEqual([b.id]);
    expect(s1.deleted.items).toEqual([a.id]);
  });

  it("includes own log entries and others' shared ones only", async () => {
    const a = (await authed({ name: 'A' })) as H;
    const b = (await otherUser(a, 'B')) as H;
    await addMember(a.user.defaultListId, b.userId!);
    const item = await call(
      a,
      'POST',
      '/api/items',
      { list_id: a.user.defaultListId, title: 'X' },
      201,
    );
    const cursor = (await sync(a, 0)).cursor;
    const priv = await call(b, 'POST', `/api/items/${item.id}/log`, { done_on: '2026-10-01' }, 201);
    // A private entry by B does not even produce a change A can see.
    const s1 = await sync(a, cursor);
    expect(s1.log).toEqual([]);
    expect(s1.items).toEqual([]);
    // B's own devices get it.
    expect((await sync(b, cursor)).log.map((e: { id: string }) => e.id)).toEqual([priv.id]);
    await call(b, 'PATCH', `/api/log/${priv.id}`, { visibility: 'shared' }, 200);
    const s2 = await sync(a, s1.cursor);
    expect(s2.log).toMatchObject([{ id: priv.id, user_name: 'B' }]);
    expect(s2.items[0].done_by).toEqual(['B']);
    await call(b, 'PATCH', `/api/log/${priv.id}`, { visibility: 'private' }, 200);
    expect((await sync(a, s2.cursor)).deleted.log).toEqual([priv.id]);
    expect((await sync(a, 0)).log).toEqual([]);
  });

  it('losing access to a shared list gives tombstones for the list and its items', async () => {
    const a = (await authed({ name: 'A' })) as H;
    const b = (await otherUser(a, 'B')) as H;
    await addMember(a.user.defaultListId, b.userId!);
    const item = await call(
      a,
      'POST',
      '/api/items',
      { list_id: a.user.defaultListId, title: 'X' },
      201,
    );
    const s0 = await sync(b, 0);
    expect(s0.items).toHaveLength(1);
    await db.batch([
      {
        sql: 'DELETE FROM list_members WHERE list_id = ? AND user_id = ?',
        params: [a.user.defaultListId, b.userId],
      },
      {
        sql: "INSERT INTO changes (entity, entity_id, list_id, op, at, visible_to) VALUES ('member', ?, ?, 'delete', ?, ?)",
        params: [b.userId, a.user.defaultListId, iso(Date.now()), b.userId],
      },
    ]);
    const s1 = await sync(b, s0.cursor);
    expect(s1.deleted.lists).toEqual([a.user.defaultListId]);
    expect(s1.deleted.items).toEqual([item.id]);
  });

  it('moving an item to a list another member cannot see tombstones it for them', async () => {
    const a = (await authed({ name: 'A' })) as H;
    const b = (await otherUser(a, 'B')) as H;
    await addMember(a.user.defaultListId, b.userId!);
    const priv = await call(a, 'POST', '/api/lists', { name: 'Mine only' }, 201);
    const item = await call(
      a,
      'POST',
      '/api/items',
      { list_id: a.user.defaultListId, title: 'X' },
      201,
    );
    const c0 = (await sync(b, 0)).cursor;
    await call(a, 'PATCH', `/api/items/${item.id}`, { list_id: priv.id }, 200);
    expect((await sync(b, c0)).deleted.items).toEqual([item.id]);
    expect((await sync(a, c0)).items.map((i: { list_id: string }) => i.list_id)).toEqual([priv.id]);
  });

  it('a stale cursor (below the pruned floor) gets a full snapshot', async () => {
    const h = (await authed()) as H;
    await call(h, 'POST', '/api/items', { list_id: h.user.defaultListId, title: 'A' }, 201);
    const c0 = (await sync(h, 0)).cursor;
    // Stay logged in (sessions slide on use) across the 90-day retention.
    h.clock.advance(45 * DAY);
    await call(h, 'GET', '/api/settings');
    h.clock.advance(46 * DAY);
    await call(h, 'POST', '/api/items', { list_id: h.user.defaultListId, title: 'B' }, 201);
    const { syncModule } = await import('../src/modules/sync');
    // Changes are stamped with the test clock; prune with the same clock.
    await syncModule.cron!(h.ctx);
    expect((await sync(h, c0 - 1)).full).toBe(true);
  });
});

describe('push', () => {
  it('replays offline ops in order, idempotently', async () => {
    const h = (await authed()) as H;
    const listId = '01JLIST0000000000000000000';
    const itemId = '01JITEM0000000000000000000';
    const ops = [
      { op_id: 'op-0000001', kind: 'list.create', id: listId, name: 'Offline list' },
      {
        op_id: 'op-0000002',
        kind: 'item.upsert',
        id: itemId,
        fields: { list_id: listId, title: 'Offline idea', tags: ['x'] },
        ts: h.clock.now() - HOUR,
      },
      {
        op_id: 'op-0000003',
        kind: 'log.create',
        id: '01JLOG00000000000000000000',
        item_id: itemId,
        done_on: '2026-10-14',
      },
      { op_id: 'op-0000004', kind: 'item.snooze', id: itemId, until: '2026-11-01T00:00:00.000Z' },
    ];
    const r1 = await push(h, ops);
    expect(r1.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    const r2 = await push(h, ops);
    expect(r2.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    const s = await sync(h, 0);
    expect(s.lists.map((l: { name: string }) => l.name).sort()).toEqual([
      'Offline list',
      'Someday',
    ]);
    expect(s.items).toMatchObject([
      { id: itemId, status: 'done', done_for_me: true, snoozed_until: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(s.log).toHaveLength(1);
  });

  it('reports a failing op without blocking the rest', async () => {
    const a = (await authed({ name: 'A' })) as H;
    const b = (await otherUser(a, 'B')) as H;
    const r = await push(b, [
      {
        op_id: 'op-bad-00001',
        kind: 'item.upsert',
        id: '01JNOPE0000000000000000000',
        fields: { list_id: a.user.defaultListId, title: 'x' },
      },
      {
        op_id: 'op-good-0001',
        kind: 'list.create',
        id: '01JGOOD0000000000000000000',
        name: 'Fine',
      },
    ]);
    expect(r.results).toMatchObject([{ ok: false, error: 'list_not_found' }, { ok: true }]);
  });

  it('clamps client timestamps from the future to server time', async () => {
    const h = (await authed()) as H;
    const item = await call(
      h,
      'POST',
      '/api/items',
      { list_id: h.user.defaultListId, title: 'A' },
      201,
    );
    await push(h, [
      {
        op_id: 'op-future-01',
        kind: 'item.upsert',
        id: item.id,
        fields: { title: 'From the future' },
        ts: h.clock.now() + 10 * DAY,
      },
    ]);
    h.clock.advance(1000);
    await push(h, [
      { op_id: 'op-later-001', kind: 'item.upsert', id: item.id, fields: { title: 'Later' } },
    ]);
    expect((await call(h, 'GET', `/api/items/${item.id}`)).item.title).toBe('Later');
  });
});
