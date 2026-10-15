// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { iso } from '../src/core/ports';
import { authed, call, DAY, db, otherUser, resetDb, type Harness } from './helpers';

beforeEach(resetDb);

type H = Harness & { user: { id: string; defaultListId: string } };

const add = (h: H, fields: Record<string, unknown>) =>
  call(h, 'POST', '/api/items', { list_id: h.user.defaultListId, title: 'x', ...fields }, 201);

describe('POST /api/suggest', () => {
  it('suggests an eligible item with reasons and remembers it', async () => {
    const h = (await authed()) as H;
    const a = await add(h, { title: 'Indoor climbing', setting: 'indoor', cost: 1 });
    await add(h, { title: 'Archived', status: 'archived' });
    const r = await call(h, 'POST', '/api/suggest', { filters: { setting: 'indoor' } }, 200);
    expect(r.eligible).toBe(1);
    expect(r.suggestion.item.id).toBe(a.id);
    expect(r.suggestion.reason_texts).toEqual(['Just added', 'Matches: indoor']);
    expect((await call(h, 'GET', `/api/items/${a.id}`)).item.last_suggested_at).not.toBeNull();
  });

  it('"Another one" excludes what was shown; nothing left gives null', async () => {
    const h = (await authed()) as H;
    const a = await add(h, { title: 'A' });
    const b = await add(h, { title: 'B' });
    const first = (await call(h, 'POST', '/api/suggest', {}, 200)).suggestion.item.id;
    const second = (await call(h, 'POST', '/api/suggest', { exclude: [first] }, 200)).suggestion
      .item.id;
    expect(new Set([first, second])).toEqual(new Set([a.id, b.id]));
    expect(
      (await call(h, 'POST', '/api/suggest', { exclude: [a.id, b.id] }, 200)).suggestion,
    ).toBeNull();
  });

  it('"Not now" snoozes for the user default, then the item comes back', async () => {
    const h = (await authed()) as H;
    const a = await add(h, { title: 'A' });
    const s = await call(h, 'POST', `/api/items/${a.id}/snooze`, {}, 200);
    expect(Date.parse(s.snoozed_until) - h.clock.now()).toBe(7 * DAY);
    expect((await call(h, 'POST', '/api/suggest', {}, 200)).suggestion).toBeNull();
    h.clock.advance(7 * DAY + 1);
    expect((await call(h, 'POST', '/api/suggest', {}, 200)).suggestion.item.id).toBe(a.id);
  });

  it('honours the per-list "include in suggestions" toggle and explicit list filters', async () => {
    const h = (await authed()) as H;
    const other = await call(h, 'POST', '/api/lists', { name: 'Other' }, 201);
    const a = await call(h, 'POST', '/api/items', { list_id: other.id, title: 'Other item' }, 201);
    await call(
      h,
      'PATCH',
      `/api/lists/${other.id}/membership`,
      { include_in_suggestions: false },
      200,
    );
    expect((await call(h, 'POST', '/api/suggest', {}, 200)).suggestion).toBeNull();
    const r = await call(h, 'POST', '/api/suggest', { filters: { list_ids: [other.id] } }, 200);
    expect(r.suggestion.item.id).toBe(a.id);
  });

  it('includes shared lists, but not items the user already did', async () => {
    const a = (await authed({ name: 'A' })) as H;
    const b = (await otherUser(a, 'B')) as H;
    await db.run(
      "INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
      a.user.defaultListId,
      b.userId,
      iso(Date.now()),
    );
    const item = await add(a, { title: 'Shared idea' });
    expect((await call(b, 'POST', '/api/suggest', {}, 200)).suggestion.item.id).toBe(item.id);
    await call(b, 'POST', `/api/items/${item.id}/log`, { done_on: '2026-10-01' }, 201);
    expect((await call(b, 'POST', '/api/suggest', {}, 200)).suggestion).toBeNull();
    expect((await call(a, 'POST', '/api/suggest', {}, 200)).suggestion.item.id).toBe(item.id);
  });

  it('respects season windows in the user time zone', async () => {
    const h = (await authed()) as H;
    // October only; "today" is 2026-10-15.
    await add(h, { title: 'Autumn', months: 1 << 9 });
    await add(h, { title: 'Summer', months: 1 << 6 });
    const r = await call(h, 'POST', '/api/suggest', {}, 200);
    expect(r.suggestion.item.title).toBe('Autumn');
    expect(r.suggestion.reason_texts).toContain('Season ends in 2 weeks');
  });
});
