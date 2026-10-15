// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authorization sweep (§9): every API route with a resource ID in its path is
 * called by a second user with the first user's IDs. None may succeed, and
 * no response may contain the first user's data. New routes are covered
 * automatically: the list comes from the OpenAPI document.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { authed, call, resetDb, type Harness } from './helpers';

type H = Harness & { user: { id: string; defaultListId: string } };

const SECRET = 'Top secret idea of Alice';
let alice: H;
let mallory: H;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await resetDb();
  alice = (await authed({ name: 'Alice', fresh: true })) as H;
  mallory = (await authed({ clock: alice.clock, name: 'Mallory', fresh: true })) as H;
  const item = await call(
    alice,
    'POST',
    '/api/items',
    { list_id: alice.user.defaultListId, title: SECRET, notes: SECRET },
    201,
  );
  const entry = await call(
    alice,
    'POST',
    `/api/items/${item.id}/log`,
    { done_on: '2026-10-01', note: SECRET },
    201,
  );
  const invite = await call(
    alice,
    'POST',
    `/api/lists/${alice.user.defaultListId}/invites`,
    {},
    201,
  );
  const link = await call(alice, 'POST', '/api/links', undefined, 200);
  const passkey = { id: 'alice-passkey' };
  await alice.ctx.db.run(
    `INSERT INTO passkeys (id, user_id, public_key, label, created_at) VALUES (?, ?, x'00', 'Alice key', '2026-01-01')`,
    passkey.id,
    alice.userId,
  );
  const sessions = await call(alice, 'GET', '/api/auth/sessions');
  const inv = await call(alice, 'POST', '/api/invites', undefined, 200);
  await alice.ctx.db.run(
    `INSERT INTO notices (id, user_id, kind, data, created_at) VALUES ('alice-notice', ?, 'passkey_added', '{}', '2026-01-01')`,
    alice.userId,
  );
  Object.assign(ids, {
    id: item.id,
    listId: alice.user.defaultListId,
    itemId: item.id,
    logId: entry.id,
    inviteId: invite.id,
    linkId: link.id,
    passkeyId: passkey.id,
    sessionId: sessions[0].id,
    instanceInviteId: inv.id,
    noticeId: 'alice-notice',
    userId: alice.userId!,
    token: invite.url.split('/join/')[1],
  });
});

/** Which of Alice's IDs to put in each path parameter, by route prefix. */
function fill(path: string): string[] {
  const variants: string[] = [];
  const idFor = (prefix: string): string[] => {
    if (prefix.startsWith('/api/lists')) return [ids.listId!];
    if (prefix.startsWith('/api/items')) return [ids.itemId!];
    if (prefix.startsWith('/api/log')) return [ids.logId!];
    if (prefix.startsWith('/api/links')) return [ids.linkId!];
    if (prefix.startsWith('/api/auth/passkeys')) return [ids.passkeyId!];
    if (prefix.startsWith('/api/auth/sessions')) return [ids.sessionId!];
    if (prefix.startsWith('/api/invites')) return [ids.instanceInviteId!];
    if (prefix.startsWith('/api/notices')) return [ids.noticeId!];
    if (prefix.startsWith('/api/admin/users')) return [ids.userId!];
    if (prefix.startsWith('/api/oauth/grants')) return ['nope'];
    return [ids.itemId!];
  };
  for (const id of idFor(path)) {
    variants.push(
      path
        .replace('{id}', id)
        .replace('{inviteId}', ids.inviteId!)
        .replace('{userId}', ids.userId!)
        .replace('{token}', 'not-a-real-token-0123456789'),
    );
  }
  return variants;
}

/** Routes where acting on someone else's ID is harmless by design. */
const EXEMPT = new Set([
  // Public preview of a list invite: needs the secret token, not an ID.
  'get /api/join/{token}',
  'post /api/join/{token}',
]);

describe('authorization sweep', () => {
  it('no route lets one user read or change another user’s resources', async () => {
    const doc = await call(alice, 'GET', '/api/openapi.json');
    const routes: [string, string][] = [];
    for (const [path, ops] of Object.entries(
      doc.paths as Record<string, Record<string, unknown>>,
    )) {
      if (!path.includes('{')) continue;
      for (const method of Object.keys(ops)) {
        if (!EXEMPT.has(`${method} ${path}`)) routes.push([method, path]);
      }
    }
    expect(routes.length).toBeGreaterThan(20);
    const failures: string[] = [];
    for (const [method, path] of routes) {
      for (const url of fill(path)) {
        const r = await mallory.json(url, {
          method: method.toUpperCase(),
          ...(method === 'get' || method === 'delete'
            ? {}
            : {
                json: {
                  name: 'x',
                  role: 'viewer',
                  label: 'x',
                  number: 42,
                  user_id: mallory.userId,
                  title: 'x',
                  done_on: '2026-10-01',
                  note: 'x',
                  status: 'archived',
                  visibility: 'shared',
                },
              }),
        });
        const leaked = JSON.stringify(r.body ?? '').includes(SECRET);
        if ((r.status >= 200 && r.status < 300) || leaked) {
          failures.push(
            `${method.toUpperCase()} ${path} → ${r.status}${leaked ? ' (leaked data)' : ''}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
    // Alice's data is untouched.
    const item = await call(alice, 'GET', `/api/items/${ids.itemId}`);
    expect(item.item).toMatchObject({ title: SECRET, status: 'done' }); // Alice logged it herself
    expect(item.log).toHaveLength(1);
    expect(await call(alice, 'GET', '/api/auth/passkeys')).toHaveLength(1);
  });

  it('list-wide reads never include another user’s data', async () => {
    for (const path of [
      '/api/lists',
      '/api/items',
      '/api/tags',
      '/api/sync?since=0',
      '/api/export/json',
      '/api/notices',
      '/api/invites',
      '/api/links',
      '/api/oauth/grants',
      '/api/auth/passkeys',
      '/api/auth/sessions',
    ]) {
      const r = await mallory.json(path);
      expect(r.status, path).toBe(200);
      expect(JSON.stringify(r.body), path).not.toContain(SECRET);
      expect(JSON.stringify(r.body), path).not.toContain('Alice');
    }
    const s = await call(mallory, 'POST', '/api/suggest', {}, 200);
    expect(s.suggestion).toBeNull();
  });

  it('admin endpoints are closed to non-admins', async () => {
    for (const [m, p] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/stats'],
      ['PATCH', '/api/admin/settings'],
    ] as const) {
      expect(
        (
          await mallory.json(p, {
            method: m,
            ...(m === 'PATCH' ? { json: { registration_mode: 'open' } } : {}),
          })
        ).status,
      ).toBe(403);
    }
  });
});
