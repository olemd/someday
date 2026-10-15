// SPDX-License-Identifier: AGPL-3.0-or-later
/** Own order, "hide for me" and hearts: personal state on (shared) lists. */
import { beforeEach, describe, expect, it } from 'vitest';
import { iso } from '../src/core/ports';
import { authed, call, db, otherUser, resetDb, type Harness } from './helpers';

beforeEach(resetDb);

type H = Harness & { user: { id: string; defaultListId: string } };

/** Unique per op: a repeated op_id is (correctly) treated as already applied. */
let opNo = 0;
const push = (h: H, ops: Record<string, unknown>[]) =>
  call(
    h,
    'POST',
    '/api/sync',
    { ops: ops.map((o) => ({ op_id: `op-${String(++opNo).padStart(8, '0')}`, ...o })) },
    200,
  ).then((r) => r.results as { ok: boolean; error?: string }[]);
const item = (h: H, id: string) =>
  call(h, 'GET', `/api/items/${id}`, undefined, 200).then((r) => r.item);
const add = (h: H, title: string, listId = h.user.defaultListId) =>
  call(h, 'POST', '/api/items', { list_id: listId, title }, 201) as Promise<{ id: string }>;

/** Two members on A's default list: A owns it, B has `role`. */
async function shared(role: 'editor' | 'viewer' = 'editor') {
  const a = (await authed({ name: 'Ada' })) as H;
  const b = (await otherUser(a, 'Bo')) as H;
  await db.run(
    'INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    a.user.defaultListId,
    b.userId,
    role,
    iso(Date.now()),
  );
  return { a, b, listId: a.user.defaultListId };
}

describe('hearts', () => {
  it('are visible to every member, with names, and can be taken back', async () => {
    const { a, b } = await shared('viewer');
    const x = await add(a, 'Northern lights');
    expect(await push(b, [{ kind: 'item.heart', id: x.id, on: true }])).toEqual([
      expect.objectContaining({ ok: true }),
    ]);
    expect(await item(a, x.id)).toMatchObject({ hearted_by: ['Bo'], hearted_by_me: false });
    expect(await item(b, x.id)).toMatchObject({ hearted_by: ['Bo'], hearted_by_me: true });
    // Hearting twice is one heart.
    await push(a, [
      { kind: 'item.heart', id: x.id, on: true },
      { kind: 'item.heart', id: x.id, on: true },
    ]);
    expect((await item(b, x.id)).hearted_by).toEqual(['Bo', 'Ada']);
    await push(b, [{ kind: 'item.heart', id: x.id, on: false }]);
    expect(await item(a, x.id)).toMatchObject({ hearted_by: ['Ada'], hearted_by_me: true });
  });

  it('reach the other members on sync, and are not edits in the history', async () => {
    const { a, b } = await shared();
    const x = await add(a, 'Sauna');
    const cursor = (await call(a, 'GET', '/api/sync?since=0', undefined, 200)).cursor;
    await push(b, [{ kind: 'item.heart', id: x.id, on: true }]);
    const pulled = await call(a, 'GET', `/api/sync?since=${cursor}`, undefined, 200);
    expect(pulled.items).toEqual([expect.objectContaining({ id: x.id, hearted_by: ['Bo'] })]);
    const history = await call(a, 'GET', `/api/items/${x.id}/history`, undefined, 200);
    expect(history).toHaveLength(1); // only the creation
  });

  it('are only for members of the list', async () => {
    const { a } = await shared();
    const x = await add(a, 'Private');
    const c = (await otherUser(a, 'Cy')) as H;
    expect(await push(c, [{ kind: 'item.heart', id: x.id, on: true }])).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
    expect((await item(a, x.id)).hearted_by).toEqual([]);
  });
});

describe('hide for me', () => {
  it('hides the idea for one member only, out of their suggestions, until shown again', async () => {
    const { a, b, listId } = await shared();
    const x = await add(a, 'Opera');
    await push(b, [{ kind: 'item.hide', id: x.id, hidden: true }]);
    expect((await item(b, x.id)).hidden_at).not.toBeNull();
    expect((await item(a, x.id)).hidden_at).toBeNull();
    const filters = { list_ids: [listId] };
    expect((await call(b, 'POST', '/api/suggest', { filters }, 200)).suggestion).toBeNull();
    expect((await call(a, 'POST', '/api/suggest', { filters }, 200)).suggestion.item.id).toBe(x.id);
    await push(b, [{ kind: 'item.hide', id: x.id, hidden: false }]);
    expect((await call(b, 'POST', '/api/suggest', { filters }, 200)).suggestion.item.id).toBe(x.id);
  });
});

describe('own order', () => {
  it('is per person, and ideas not placed lose their place', async () => {
    const { a, b, listId } = await shared();
    const x = await add(a, 'X');
    const y = await add(a, 'Y');
    const z = await add(a, 'Z');
    const elsewhere = await call(a, 'POST', '/api/lists', { name: 'Other' }, 201);
    const w = await add(a, 'W', elsewhere.id);
    const positions = async (h: H) =>
      Object.fromEntries(
        (await call(h, 'GET', `/api/items?list_id=${listId}`, undefined, 200)).map(
          (i: { title: string; position: number | null }) => [i.title, i.position],
        ),
      );

    // W is on another list: ignored.
    await push(a, [{ kind: 'list.order', id: listId, ids: [z.id, w.id, x.id, y.id] }]);
    expect(await positions(a)).toEqual({ X: 1, Y: 2, Z: 0 });
    expect(await positions(b)).toEqual({ X: null, Y: null, Z: null });
    expect((await item(a, w.id)).position).toBeNull();

    await push(a, [{ kind: 'list.order', id: listId, ids: [y.id, x.id] }]);
    expect(await positions(a)).toEqual({ X: 1, Y: 0, Z: null });
    await push(a, [{ kind: 'list.order', id: listId, ids: [] }]);
    expect(await positions(a)).toEqual({ X: null, Y: null, Z: null });
  });

  it('is only for members of the list', async () => {
    const { a, listId } = await shared();
    const x = await add(a, 'X');
    const c = (await otherUser(a, 'Cy')) as H;
    expect(await push(c, [{ kind: 'list.order', id: listId, ids: [x.id] }])).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
  });
});
