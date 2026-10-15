// SPDX-License-Identifier: AGPL-3.0-or-later
import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExportSchema } from '../src/shared/schemas/export';
import { exportJsonSchema } from '../src/shared/schemas/export-json';
import committedSchema from '../docs/someday-export-v1.schema.json';
import { authed, call, DAY, db, otherUser, resetDb, type Harness } from './helpers';

beforeEach(resetDb);

type H = Harness & { user: { id: string; defaultListId: string } };

async function seed() {
  const a = (await authed({ name: 'Ann' })) as H;
  const b = (await otherUser(a, 'Bob')) as H;
  const inv = await call(a, 'POST', `/api/lists/${a.user.defaultListId}/invites`, {}, 201);
  await call(b, 'POST', `/api/join/${inv.url.split('/join/')[1]}`, undefined, 200);
  const item = await call(
    a,
    'POST',
    '/api/items',
    {
      list_id: a.user.defaultListId,
      title: 'Northern lights',
      notes: 'Go north\nIn winter',
      months: 0b111100000111,
      tags: ['nature'],
      links: [{ url: 'https://example.com', label: 'Forecast' }],
    },
    201,
  );
  await call(
    a,
    'POST',
    `/api/items/${item.id}/log`,
    { done_on: '2026-10-01', note: 'Wow', rating: 5, visibility: 'shared' },
    201,
  );
  await call(
    b,
    'POST',
    `/api/items/${item.id}/log`,
    { done_on: '2026-10-02', note: 'Bob secret' },
    201,
  );
  const own = await call(b, 'POST', '/api/lists', { name: 'Bøker å lese' }, 201);
  await call(b, 'POST', '/api/items', { list_id: own.id, title: 'Dune' }, 201);
  return { a, b, item, own };
}

async function download(h: Harness) {
  const res = await h.fetch('/api/export');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  expect(res.headers.get('content-disposition')).toMatch(
    /attachment; filename="someday-export-2026-10-15\.zip"/,
  );
  return new Uint8Array(await res.arrayBuffer());
}

describe('export', () => {
  it('zips JSON (v1), one Markdown file per list and a README; only my own log entries', async () => {
    const { b } = await seed();
    const files = unzipSync(await download(b));
    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'markdown/boker-a-lese.md',
      'markdown/someday-2.md',
      'markdown/someday.md',
      'someday-export.json',
    ]);
    const data = ExportSchema.parse(JSON.parse(strFromU8(files['someday-export.json']!)));
    expect(data.user.display_name).toBe('Bob');
    const shared = data.lists.find((l) => l.shared_from)!;
    expect(shared.shared_from).toEqual({ owner: 'Ann' });
    const lights = shared.items[0]!;
    // Ann's shared entry is hers: never exported for Bob.
    expect(lights.log).toEqual([
      {
        done_on: '2026-10-02',
        note: 'Bob secret',
        rating: null,
        visibility: 'private',
        created_at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/public_key|passkey|token/);
    const md = strFromU8(files['markdown/someday.md'] ?? files['markdown/someday-2.md']!);
    expect(md).toContain('# Someday');
  });

  it('renders readable Markdown grouped by status', async () => {
    const { a } = await seed();
    const files = unzipSync(await download(a));
    const md = strFromU8(files['markdown/someday.md']!);
    expect(md).toContain('## Ideas');
    expect(md).toContain('- **Northern lights** (#nature)');
    expect(md).toContain('  - [Forecast](https://example.com)');
    expect(md).toContain('  - Done 2026-10-01 ★★★★★: Wow');
    expect(md).not.toContain('Bob secret');
  });

  it('keeps the committed JSON Schema in step with the zod schema', () => {
    expect(committedSchema).toEqual(JSON.parse(JSON.stringify(exportJsonSchema())));
  });
});

describe('import', () => {
  it('dry-runs, then imports into new lists with fresh IDs', async () => {
    const { a } = await seed();
    const zip = await download(a);
    const fresh = (await authed({ name: 'Elsewhere' })) as H;
    const post = (q: string, body: BodyInit) =>
      fresh.json(`/api/import?${q}`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/zip' },
      });
    const dry = await post('dry_run=true', zip);
    expect(dry.body).toMatchObject({ lists: 1, items: 1, log_entries: 1, tags: 1, dry_run: true });
    expect(await call(fresh, 'GET', '/api/items')).toEqual([]);
    const real = await post('dry_run=false', zip);
    expect(real.status).toBe(200);
    const items = await call(fresh, 'GET', '/api/items');
    expect(items).toMatchObject([
      { title: 'Northern lights', tags: ['nature'], months: 0b111100000111, done_for_me: true },
    ]);
    expect(items[0].id).not.toBe((await call(a, 'GET', '/api/items'))[0].id);
    expect(
      (await call(fresh, 'GET', '/api/lists')).map((l: { name: string }) => l.name).sort(),
    ).toEqual(['Someday', 'Someday']);
  });

  it('merges a JSON export into an existing list', async () => {
    const { a } = await seed();
    const json = await call(a, 'GET', '/api/export/json');
    const fresh = (await authed({ name: 'Elsewhere' })) as H;
    const r = await fresh.json(
      `/api/import?mode=merge&list_id=${fresh.user.defaultListId}&dry_run=false`,
      {
        method: 'POST',
        json,
      },
    );
    expect(r.body).toMatchObject({ lists: 0, items: 1 });
    expect(await call(fresh, 'GET', '/api/lists')).toHaveLength(1);
    // A merge target the user cannot edit is refused.
    const other = (await otherUser(fresh, 'X')) as H;
    expect(
      (
        await fresh.json(
          `/api/import?mode=merge&list_id=${other.user.defaultListId}&dry_run=false`,
          { method: 'POST', json },
        )
      ).status,
    ).toBe(404);
  });

  it('rejects files that are not someday-export/v1', async () => {
    const h = (await authed()) as H;
    expect(
      (await h.json('/api/import', { method: 'POST', json: { schema: 'other' } })).body.error,
    ).toBe('bad_export');
    expect((await h.json('/api/import', { method: 'POST', body: 'nope' })).body.error).toBe(
      'bad_json',
    );
    const zip = zipSync({ 'x.txt': strToU8('x') });
    expect((await h.json('/api/import', { method: 'POST', body: zip })).body.error).toBe(
      'no_export',
    );
  });
});

describe('account deletion', () => {
  it('needs a fresh passkey and a decision for each owned shared list', async () => {
    const { a, b } = await seed();
    expect((await a.json('/api/account/delete', { method: 'POST', json: {} })).body.error).toBe(
      'reauth_required',
    );
    await db.run(
      'UPDATE sessions SET reauth_at = ? WHERE user_id = ?',
      new Date(a.clock.now()).toISOString(),
      a.userId,
    );
    const info = await call(a, 'GET', '/api/account/deletion');
    expect(info.shared_lists).toMatchObject([
      { id: a.user.defaultListId, members: [{ display_name: 'Bob' }] },
    ]);
    expect((await a.json('/api/account/delete', { method: 'POST', json: {} })).body.error).toBe(
      'decision_required',
    );
    await call(
      a,
      'POST',
      '/api/account/delete',
      { lists: { [a.user.defaultListId]: { transfer_to: b.userId } } },
      200,
    );
    // Logged out everywhere; Bob now owns the list, Ann is gone from it.
    expect((await a.json('/api/settings')).status).toBe(401);
    const list = await call(b, 'GET', `/api/lists/${a.user.defaultListId}`);
    expect(list).toMatchObject({ role: 'owner', member_count: 1 });
    // Hard delete after the grace period.
    b.clock.advance(31 * DAY);
    const { accountModule } = await import('../src/modules/takeaway');
    await accountModule.cron!(b.ctx);
    expect(await db.first('SELECT 1 FROM users WHERE id = ?', a.userId)).toBeNull();
    expect(await db.first("SELECT 1 FROM item_log WHERE note = 'Wow'")).toBeNull();
    expect((await call(b, 'GET', '/api/items')).map((i: { title: string }) => i.title)).toContain(
      'Northern lights',
    );
  });

  it('deleting a shared list with the account removes it for everyone', async () => {
    const { a, b } = await seed();
    await db.run(
      'UPDATE sessions SET reauth_at = ? WHERE user_id = ?',
      new Date(a.clock.now()).toISOString(),
      a.userId,
    );
    await call(
      a,
      'POST',
      '/api/account/delete',
      { lists: { [a.user.defaultListId]: 'delete' } },
      200,
    );
    expect((await b.json(`/api/lists/${a.user.defaultListId}`)).status).toBe(404);
  });
});
