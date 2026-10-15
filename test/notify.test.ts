// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { iso, type PushSender } from '../src/core/ports';
import { zonedToEpoch } from '../src/core/time';
import { runScheduled } from '../src/modules/cron';
import { sendAgentNotification } from '../src/modules/notify/agent';
import { authed, call, DAY, db, HOUR, MIN, otherUser, resetDb, type Harness } from './helpers';

beforeEach(resetDb);

type H = Harness & {
  user: { id: string; defaultListId: string };
  sent: { user: string; payload: any }[];
};

/** A push sender that records what would be delivered, per subscription endpoint. */
function recorder() {
  const sent: { endpoint: string; payload: any }[] = [];
  const push: PushSender = {
    async send(sub, payload) {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return 201;
    },
  };
  return { sent, push };
}

const OSLO = 'Europe/Oslo';
/** Thursday 2026-10-15 07:00 Oslo. */
const MORNING = zonedToEpoch(2026, 10, 15, 7, 0, OSLO);

async function user(name: string, rec: ReturnType<typeof recorder>, base?: Harness) {
  const h = (
    base ? await otherUser(base, name) : await authed({ name, push: rec.push, now: MORNING })
  ) as H;
  if (base) h.ctx.push = rec.push;
  await call(h, 'PATCH', '/api/settings', { timezone: OSLO }, 200);
  await db.run(
    'INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)',
    `https://push.example/${name}`,
    h.userId,
    'k'.repeat(87),
    'a'.repeat(22),
    iso(h.clock.now()),
  );
  return h;
}

const sentTo = (rec: ReturnType<typeof recorder>, name: string) =>
  rec.sent.filter((s) => s.endpoint.endsWith(`/${name}`)).map((s) => s.payload);

async function cron(h: Harness) {
  await runScheduled(h.ctx);
  await h.settle();
}

describe('window reminders', () => {
  it('pushes at 09:00 local for windows opening today, once', async () => {
    const rec = recorder();
    const h = await user('kari', rec);
    await call(
      h,
      'POST',
      '/api/items',
      { list_id: h.user.defaultListId, title: 'Autumn market', valid_from: '2026-10-15' },
      201,
    );
    await call(
      h,
      'POST',
      '/api/items',
      { list_id: h.user.defaultListId, title: 'Closing soon', valid_to: '2026-10-22' },
      201,
    );
    await cron(h); // 07:00: too early
    expect(sentTo(rec, 'kari')).toEqual([]);
    h.clock.advance(2 * HOUR + 5 * MIN); // 09:05
    await cron(h);
    const sent = sentTo(rec, 'kari');
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('2 ideas: windows opening or closing');
    await cron(h);
    expect(sentTo(rec, 'kari')).toHaveLength(1);
  });

  it('respects the toggle', async () => {
    const rec = recorder();
    const h = await user('kari', rec);
    await call(h, 'PATCH', '/api/settings', { notify_window: false }, 200);
    await call(
      h,
      'POST',
      '/api/items',
      { list_id: h.user.defaultListId, title: 'X', valid_from: '2026-10-15' },
      201,
    );
    h.clock.advance(3 * HOUR);
    await cron(h);
    expect(sentTo(rec, 'kari')).toEqual([]);
  });
});

describe('nudges', () => {
  it('are opt-in, drawn on enable, sent at their time with a suggestion', async () => {
    const rec = recorder();
    const h = await user('kari', rec);
    const item = await call(
      h,
      'POST',
      '/api/items',
      { list_id: h.user.defaultListId, title: 'Bake bread' },
      201,
    );
    await cron(h);
    expect(await db.all('SELECT * FROM nudge_slots')).toEqual([]);
    await call(
      h,
      'PATCH',
      '/api/settings',
      { nudge_enabled: true, nudge_count: 7, nudge_period: 'week' },
      200,
    );
    const slots = await db.all<{ send_at: string }>(
      "SELECT send_at FROM nudge_slots WHERE status = 'pending' ORDER BY send_at",
    );
    // Thursday 07:00: Thu–Sun remain → round(7 × 4 / 7) = 4.
    expect(slots).toHaveLength(4);
    h.clock.t = Date.parse(slots[0]!.send_at) + MIN;
    await cron(h);
    const sent = sentTo(rec, 'kari');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'How about this?', url: `/items/${item.id}` });
    // Re-running cron never double-sends.
    await cron(h);
    expect(sentTo(rec, 'kari')).toHaveLength(1);
  });

  it('skips slots during a pause and when nothing fits', async () => {
    const rec = recorder();
    const h = await user('kari', rec);
    await call(h, 'PATCH', '/api/settings', { nudge_enabled: true, nudge_count: 7 }, 200);
    const [first] = await db.all<{ send_at: string }>(
      "SELECT send_at FROM nudge_slots WHERE status = 'pending' ORDER BY send_at",
    );
    h.clock.t = Date.parse(first!.send_at) + MIN;
    await cron(h); // no items at all
    expect(
      await db.first('SELECT status FROM nudge_slots WHERE send_at = ?', first!.send_at),
    ).toEqual({ status: 'skipped_empty' });
    await call(h, 'POST', '/api/items', { list_id: h.user.defaultListId, title: 'X' }, 201);
    await call(
      h,
      'PATCH',
      '/api/settings',
      { nudge_paused_until: iso(h.clock.now() + 30 * DAY) },
      200,
    );
    const pending = await db.all<{ send_at: string }>(
      "SELECT send_at FROM nudge_slots WHERE status = 'pending' ORDER BY send_at",
    );
    h.clock.t = Date.parse(pending[pending.length - 1]!.send_at) + MIN;
    await cron(h);
    expect(sentTo(rec, 'kari')).toEqual([]);
    expect(
      (await db.all("SELECT 1 FROM nudge_slots WHERE status = 'skipped_paused'")).length,
    ).toBeGreaterThan(0);
  });

  it('redraws for each new period', async () => {
    const rec = recorder();
    const h = await user('kari', rec);
    await call(h, 'PATCH', '/api/settings', { nudge_enabled: true, nudge_count: 2 }, 200);
    h.clock.t = zonedToEpoch(2026, 10, 19, 0, 5, OSLO); // next Monday
    await cron(h);
    const next = await db.all(
      "SELECT 1 FROM nudge_slots WHERE period_start = '2026-10-19' AND status = 'pending'",
    );
    expect(next).toHaveLength(2);
  });
});

describe('shared activity', () => {
  async function pair() {
    const rec = recorder();
    const a = await user('Ann', rec);
    const b = await user('Bob', rec, a);
    const inv = await call(a, 'POST', `/api/lists/${a.user.defaultListId}/invites`, {}, 201);
    await call(b, 'POST', `/api/join/${inv.url.split('/join/')[1]}`, undefined, 200);
    a.clock.t = zonedToEpoch(2026, 10, 15, 12, 0, OSLO);
    return { rec, a, b };
  }

  it("batches others' new ideas into one push per list per 30 minutes", async () => {
    const { rec, a, b } = await pair();
    await call(a, 'POST', '/api/items', { list_id: a.user.defaultListId, title: 'One' }, 201);
    await cron(a);
    expect(sentTo(rec, 'Bob')).toMatchObject([{ body: 'Ann added “One”', title: 'Someday' }]);
    expect(sentTo(rec, 'Ann')).toEqual([]);
    await call(a, 'POST', '/api/items', { list_id: a.user.defaultListId, title: 'Two' }, 201);
    await call(a, 'POST', '/api/items', { list_id: a.user.defaultListId, title: 'Three' }, 201);
    a.clock.advance(15 * MIN);
    await cron(a);
    expect(sentTo(rec, 'Bob')).toHaveLength(1);
    a.clock.advance(16 * MIN);
    await cron(a);
    expect(sentTo(rec, 'Bob')[1]).toMatchObject({ body: 'Ann: 2 updates' });
    void b;
  });

  it('never notifies for private or anonymous log entries; shared ones do', async () => {
    const { rec, a, b } = await pair();
    const item = await call(
      a,
      'POST',
      '/api/items',
      { list_id: a.user.defaultListId, title: 'X' },
      201,
    );
    await db.run('DELETE FROM shared_queue');
    await call(b, 'POST', `/api/items/${item.id}/log`, { done_on: '2026-10-14' }, 201);
    await cron(a);
    expect(sentTo(rec, 'Ann')).toEqual([]);
    await call(
      b,
      'POST',
      `/api/items/${item.id}/log`,
      { done_on: '2026-10-15', visibility: 'shared' },
      201,
    );
    await cron(a);
    expect(sentTo(rec, 'Ann')).toMatchObject([{ body: 'Bob did “X”' }]);
  });

  it('waits for quiet hours to end', async () => {
    const { rec, a } = await pair();
    a.clock.t = zonedToEpoch(2026, 10, 15, 23, 0, OSLO);
    await call(a, 'POST', '/api/items', { list_id: a.user.defaultListId, title: 'Late' }, 201);
    await cron(a);
    expect(sentTo(rec, 'Bob')).toEqual([]);
    a.clock.t = zonedToEpoch(2026, 10, 16, 8, 1, OSLO);
    await cron(a);
    expect(sentTo(rec, 'Bob')).toHaveLength(1);
  });
});

describe('agent notifications', () => {
  it('are capped per day and deferred in quiet hours', async () => {
    const rec = recorder();
    const h = await user('kari', rec);
    await call(h, 'PATCH', '/api/settings', { agent_daily_max: 2 }, 200);
    h.clock.t = zonedToEpoch(2026, 10, 15, 12, 0, OSLO);
    const send = () => sendAgentNotification(h.ctx, h.userId!, { title: 'Hi', body: 'There' });
    expect(await send()).toBe('sent');
    expect(await send()).toBe('sent');
    expect(await send()).toBe('limit');
    h.clock.t = zonedToEpoch(2026, 10, 15, 23, 0, OSLO);
    expect(await sendAgentNotification(h.ctx, h.userId!, { title: 'x', body: 'y' })).toBe('limit');
    h.clock.t = zonedToEpoch(2026, 10, 16, 1, 0, OSLO);
    expect(await send()).toBe('deferred');
    h.clock.t = zonedToEpoch(2026, 10, 16, 8, 30, OSLO);
    await cron(h);
    expect(sentTo(rec, 'kari')).toHaveLength(3);
  });
});
