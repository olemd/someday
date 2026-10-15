// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The offline data layer (§6): lists, items and log entries mirrored in
 * IndexedDB per user, an outbox of writes replayed in order, and sync with
 * the server (`/api/sync`).
 *
 * Every write the UI makes goes through `enqueue`: it is applied to the local
 * state at once (optimistic), stored in the outbox, and pushed when online.
 * Reads work fully offline. Ops the server rejects are kept as "sync
 * problems" and shown until dismissed — never dropped silently — and trigger
 * a full resync so local state matches the server again.
 */
import { batch, computed, signal } from '@preact/signals';
import { ulid } from '../../core/ulid';
import type { Item, List, LogEntry, Visibility } from '../../shared/schemas/items';
import { ApiError, get, NetworkError, post } from './api';
import { auth } from './store';

export type Op =
  | {
      kind: 'item.upsert';
      id: string;
      fields: Record<string, unknown>;
      ts: number;
    }
  | { kind: 'item.delete'; id: string }
  | { kind: 'item.snooze'; id: string; until: string | null }
  | { kind: 'item.seen'; id: string; at: number }
  | { kind: 'item.hide'; id: string; hidden: boolean }
  | { kind: 'item.heart'; id: string; on: boolean }
  | {
      kind: 'log.create';
      id: string;
      item_id: string;
      done_on: string;
      note: string;
      rating: number | null;
      visibility?: Visibility;
    }
  | {
      kind: 'log.update';
      id: string;
      patch: { done_on?: string; note?: string; rating?: number | null; visibility?: Visibility };
    }
  | { kind: 'log.delete'; id: string }
  | { kind: 'list.create'; id: string; name: string }
  | { kind: 'list.update'; id: string; name: string }
  | { kind: 'list.order'; id: string; ids: string[] }
  | {
      kind: 'list.membership';
      id: string;
      include_in_suggestions?: boolean;
      log_visibility?: Visibility;
    };

type Queued = Op & { op_id: string; queued_at: number; seq?: number };
export type FailedOp = Queued & { error: string; message: string };

export const lists = signal<List[]>([]);
export const items = signal<Map<string, Item>>(new Map());
export const logs = signal<LogEntry[]>([]);
export const pendingCount = signal(0);
export const failedOps = signal<FailedOp[]>([]);
export const syncing = signal(false);
export const lastSynced = signal<number | null>(null);
/** False until local data has been loaded (from IndexedDB or the first sync). */
export const ready = signal(false);

export const listById = computed(() => new Map(lists.value.map((l) => [l.id, l])));
export const itemList = computed(() => [...items.value.values()]);

// ── IndexedDB ──────────────────────────────────────────────────────────

const STORES = ['lists', 'items', 'log', 'meta', 'outbox', 'failed'] as const;
type Store = (typeof STORES)[number];
let db: IDBDatabase | null = null;
let dbName = '';

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('lists', { keyPath: 'id' });
      d.createObjectStore('items', { keyPath: 'id' });
      d.createObjectStore('log', { keyPath: 'id' });
      d.createObjectStore('meta');
      d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      d.createObjectStore('failed', { keyPath: 'op_id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Run `fn` in one transaction over `stores`; resolves when it commits. */
function tx(stores: Store[], fn: (t: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const t = db.transaction(stores, 'readwrite');
    fn(t);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function all<T>(store: Store): Promise<T[]> {
  if (!db) return [];
  return req(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

async function meta<T>(key: string): Promise<T | undefined> {
  if (!db) return undefined;
  return req(db.transaction('meta').objectStore('meta').get(key)) as Promise<T | undefined>;
}

// ── Local state ────────────────────────────────────────────────────────

interface Changes {
  lists?: List[];
  items?: Item[];
  log?: LogEntry[];
  deleted?: { lists?: string[]; items?: string[]; log?: string[] };
}

/** Apply upserts and tombstones to memory and IndexedDB (cascading deletes). */
async function save(c: Changes, replaceAll = false) {
  const delLists = new Set(c.deleted?.lists ?? []);
  const delItems = new Set(c.deleted?.items ?? []);
  const delLog = new Set(c.deleted?.log ?? []);
  const nextLists = replaceAll
    ? new Map<string, List>()
    : new Map(lists.value.map((l) => [l.id, l]));
  const nextItems = replaceAll ? new Map<string, Item>() : new Map(items.value);
  const nextLog = replaceAll
    ? new Map<string, LogEntry>()
    : new Map(logs.value.map((e) => [e.id, e]));

  for (const id of delLists) nextLists.delete(id);
  for (const l of c.lists ?? []) nextLists.set(l.id, l);
  for (const [id, it] of nextItems) if (delLists.has(it.list_id)) delItems.add(id);
  for (const id of delItems) nextItems.delete(id);
  for (const it of c.items ?? []) {
    nextItems.set(it.id, it);
    delItems.delete(it.id);
  }
  for (const [id, e] of nextLog) if (delItems.has(e.item_id)) delLog.add(id);
  for (const id of delLog) nextLog.delete(id);
  for (const e of c.log ?? []) nextLog.set(e.id, e);

  batch(() => {
    lists.value = [...nextLists.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    items.value = nextItems;
    logs.value = [...nextLog.values()];
  });

  await tx(['lists', 'items', 'log'], (t) => {
    const ls = t.objectStore('lists');
    const is = t.objectStore('items');
    const lg = t.objectStore('log');
    if (replaceAll) {
      ls.clear();
      is.clear();
      lg.clear();
    }
    for (const id of delLists) ls.delete(id);
    for (const id of delItems) is.delete(id);
    for (const id of delLog) lg.delete(id);
    for (const l of c.lists ?? []) ls.put(l);
    for (const it of c.items ?? []) is.put(it);
    for (const e of c.log ?? []) lg.put(e);
  });
}

const myId = () => auth.value?.user?.id ?? '';

/**
 * The shape of the local mirror. Bump it when `Item` (or a list or log
 * entry) gains fields: a mirror written by an older version lacks them, and
 * a pull only returns what changed, so the next sync is then a full one.
 */
const DATA_VERSION = 2;

/** Fields added after DATA_VERSION 1, so an older mirror still renders until it is refreshed. */
const ITEM_DEFAULTS = {
  position: null,
  hidden_at: null,
  hearted_by: [],
  hearted_by_me: false,
} satisfies Partial<Item>;

function emptyItem(id: string, now: string): Item {
  return {
    id,
    list_id: '',
    title: '',
    notes: '',
    status: 'idea',
    repeatable: false,
    duration: null,
    setting: null,
    cost: null,
    energy: null,
    social: null,
    valid_from: null,
    valid_to: null,
    months: null,
    links: [],
    location: null,
    tags: [],
    created_by: myId(),
    created_at: now,
    updated_at: now,
    done_for_me: false,
    my_last_done_on: null,
    snoozed_until: null,
    last_suggested_at: null,
    position: null,
    hidden_at: null,
    hearted_by: [],
    hearted_by_me: false,
    done_count: null,
    done_by: [],
  };
}

/** What an op does to local state, before the server has seen it. */
async function applyLocal(op: Op): Promise<void> {
  const now = new Date().toISOString();
  switch (op.kind) {
    case 'item.upsert': {
      const cur = items.value.get(op.id) ?? emptyItem(op.id, now);
      const fields = { ...op.fields } as Partial<Item>;
      if (fields.tags) fields.tags = [...new Set(fields.tags.map((t) => t.trim().toLowerCase()))];
      return save({ items: [{ ...cur, ...fields, updated_at: now }] });
    }
    case 'item.delete':
      return save({ deleted: { items: [op.id] } });
    case 'item.snooze':
    case 'item.seen': {
      const cur = items.value.get(op.id);
      if (!cur) return;
      return save({
        items: [
          op.kind === 'item.snooze'
            ? { ...cur, snoozed_until: op.until }
            : { ...cur, last_suggested_at: new Date(op.at).toISOString() },
        ],
      });
    }
    case 'item.hide': {
      const cur = items.value.get(op.id);
      if (!cur) return;
      return save({ items: [{ ...cur, hidden_at: op.hidden ? now : null }] });
    }
    case 'item.heart': {
      const cur = items.value.get(op.id);
      if (!cur || cur.hearted_by_me === op.on) return;
      // Names are what the server sends; drop (or add) one copy of mine.
      const name = auth.value?.user?.display_name ?? '';
      const by = [...cur.hearted_by];
      if (op.on) by.push(name);
      else if (by.lastIndexOf(name) >= 0) by.splice(by.lastIndexOf(name), 1);
      return save({ items: [{ ...cur, hearted_by_me: op.on, hearted_by: by }] });
    }
    case 'list.order': {
      const at = new Map(op.ids.map((id, i) => [id, i]));
      return save({
        items: itemList.value
          .filter((i) => i.list_id === op.id)
          .map((i) => ({ ...i, position: at.get(i.id) ?? null })),
      });
    }
    case 'log.create': {
      const item = items.value.get(op.item_id);
      const list = item ? listById.value.get(item.list_id) : undefined;
      const single = (list?.member_count ?? 1) <= 1;
      const entry: LogEntry = {
        id: op.id,
        item_id: op.item_id,
        user_id: myId(),
        user_name: null,
        done_on: op.done_on,
        note: op.note,
        rating: op.rating,
        visibility: single ? 'private' : (op.visibility ?? list?.log_visibility ?? 'private'),
        created_at: now,
        updated_at: now,
        mine: true,
      };
      const changes: Changes = { log: [entry] };
      if (item) {
        const last =
          item.my_last_done_on && item.my_last_done_on > op.done_on
            ? item.my_last_done_on
            : op.done_on;
        changes.items = [
          {
            ...item,
            done_for_me: true,
            my_last_done_on: last,
            status: single && !item.repeatable ? 'done' : item.status,
          },
        ];
      }
      return save(changes);
    }
    case 'log.update': {
      const cur = logs.value.find((e) => e.id === op.id);
      if (!cur) return;
      return save({ log: [{ ...cur, ...op.patch, updated_at: now }] });
    }
    case 'log.delete': {
      const cur = logs.value.find((e) => e.id === op.id);
      if (!cur) return;
      const item = items.value.get(cur.item_id);
      const mineLeft = logs.value.filter(
        (e) => e.mine && e.item_id === cur.item_id && e.id !== op.id,
      );
      const changes: Changes = { deleted: { log: [op.id] } };
      if (item) {
        changes.items = [
          {
            ...item,
            done_for_me: mineLeft.length > 0,
            my_last_done_on:
              mineLeft
                .map((e) => e.done_on)
                .sort()
                .pop() ?? null,
          },
        ];
      }
      return save(changes);
    }
    case 'list.create': {
      const me = auth.value?.user;
      return save({
        lists: [
          {
            id: op.id,
            name: op.name,
            role: 'owner',
            created_at: now,
            updated_at: now,
            member_count: 1,
            members: me ? [{ user_id: me.id, display_name: me.display_name, role: 'owner' }] : [],
            include_in_suggestions: true,
            log_visibility: 'private',
            anon_count_min_members: null,
            anonymous_available: false,
          },
        ],
      });
    }
    case 'list.update':
    case 'list.membership': {
      const cur = listById.value.get(op.id);
      if (!cur) return;
      const { kind: _k, id: _i, ...patch } = op;
      return save({ lists: [{ ...cur, ...patch }] });
    }
  }
}

async function refreshQueueState() {
  pendingCount.value = (await all('outbox')).length;
  failedOps.value = await all<FailedOp>('failed');
}

/** Apply a write locally, queue it, and sync soon. */
export async function enqueue(op: Op): Promise<void> {
  const queued: Queued = { ...op, op_id: ulid(), queued_at: Date.now() };
  await applyLocal(op);
  await tx(['outbox'], (t) => t.objectStore('outbox').add(queued));
  await refreshQueueState();
  scheduleSync();
}

export async function dismissFailed(opId: string) {
  await tx(['failed'], (t) => t.objectStore('failed').delete(opId));
  await refreshQueueState();
}

// ── Sync ───────────────────────────────────────────────────────────────

interface PullResponse extends Required<Omit<Changes, 'deleted'>> {
  cursor: number;
  full: boolean;
  more: boolean;
  deleted: { lists: string[]; items: string[]; log: string[] };
}

/** Push the outbox in order. Returns false while offline. */
async function pushOutbox(): Promise<{ online: boolean; failed: boolean }> {
  let failed = false;
  for (;;) {
    const queue = (await all<Queued>('outbox')).sort((a, b) => a.seq! - b.seq!).slice(0, 100);
    if (!queue.length) return { online: true, failed };
    let results: { op_id: string; ok: boolean; error?: string; message?: string }[];
    try {
      results = (
        await post<{ results: typeof results }>('/sync', {
          ops: queue.map(({ seq: _s, queued_at: _q, ...op }) =>
            op.kind === 'item.upsert' ? { ...op, ts: op.ts } : op,
          ),
        })
      ).results;
    } catch (err) {
      if (err instanceof NetworkError) return { online: false, failed };
      throw err;
    }
    const byId = new Map(results.map((r) => [r.op_id, r]));
    await tx(['outbox', 'failed'], (t) => {
      for (const q of queue) {
        const r = byId.get(q.op_id);
        if (!r) continue;
        t.objectStore('outbox').delete(q.seq!);
        if (!r.ok) {
          failed = true;
          t.objectStore('failed').put({
            ...q,
            error: r.error ?? 'error',
            message: r.message ?? '',
          });
        }
      }
    });
  }
}

async function pullChanges(forceFull = false): Promise<boolean> {
  let cursor = forceFull ? 0 : ((await meta<number>('cursor')) ?? 0);
  for (;;) {
    let r: PullResponse;
    try {
      r = await get<PullResponse>(`/sync?since=${cursor}`);
    } catch (err) {
      if (err instanceof NetworkError) return false;
      throw err;
    }
    await save(r, r.full);
    cursor = r.cursor;
    const full = r.full;
    await tx(['meta'], (t) => {
      t.objectStore('meta').put(cursor, 'cursor');
      if (full) t.objectStore('meta').put(DATA_VERSION, 'version');
    });
    if (!r.more) break;
  }
  // Ops queued meanwhile are not on the server yet: re-apply them on top.
  for (const q of (await all<Queued>('outbox')).sort((a, b) => a.seq! - b.seq!)) {
    await applyLocal(q);
  }
  return true;
}

let running: Promise<void> | null = null;
let again = false;

/** Push, then pull. Concurrent calls coalesce into one extra run. */
export function sync(opts: { full?: boolean } = {}): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    syncing.value = true;
    try {
      const pushed = await pushOutbox();
      if (pushed.online) {
        // A rejected op means local state diverged: take the server's.
        if (await pullChanges(opts.full || pushed.failed)) lastSynced.value = Date.now();
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error('sync failed', err);
    } finally {
      await refreshQueueState();
      syncing.value = false;
      running = null;
      if (again) {
        again = false;
        void sync();
      }
    }
  })();
  return running;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleSync(ms = 300) {
  clearTimeout(timer);
  timer = setTimeout(() => void sync(), ms);
}

let started = false;

/** Open this user's local database, show what is there, then sync. */
export async function startData(userId: string): Promise<void> {
  const name = `someday-${userId}`;
  if (dbName !== name) {
    db?.close();
    db = await openDb(name);
    dbName = name;
    const [l, i, g] = await Promise.all([
      all<List>('lists'),
      all<Item>('items'),
      all<LogEntry>('log'),
    ]);
    batch(() => {
      lists.value = l.sort((a, b) => a.created_at.localeCompare(b.created_at));
      items.value = new Map(i.map((x) => [x.id, { ...ITEM_DEFAULTS, ...x }]));
      logs.value = g;
    });
    await refreshQueueState();
  }
  if (lists.value.length) ready.value = true;
  // A mirror from an older version: replace it with a full snapshot.
  await sync({ full: (await meta<number>('version')) !== DATA_VERSION });
  ready.value = true;
  if (started) return;
  started = true;
  // The `online` event is unreliable (captive portals), so also sync when
  // the app becomes visible and every minute while it is.
  addEventListener('online', () => void sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sync();
  });
  setInterval(() => document.visibilityState === 'visible' && void sync(), 60_000);
}

/** Logout: forget this user's local data (queued writes included). */
export async function clearLocalData(): Promise<void> {
  db?.close();
  db = null;
  if (dbName) await req(indexedDB.deleteDatabase(dbName)).catch(() => undefined);
  dbName = '';
  batch(() => {
    lists.value = [];
    items.value = new Map();
    logs.value = [];
  });
}

// ── Write helpers used by the screens ──────────────────────────────────

export const newId = () => ulid();

export function saveItem(id: string, fields: Record<string, unknown>) {
  return enqueue({ kind: 'item.upsert', id, fields, ts: Date.now() });
}

export const deleteItem = (id: string) => enqueue({ kind: 'item.delete', id });
export const snoozeItem = (id: string, until: string | null) =>
  enqueue({ kind: 'item.snooze', id, until });
export const markSeen = (id: string) => enqueue({ kind: 'item.seen', id, at: Date.now() });
export const hideItem = (id: string, hidden: boolean) => enqueue({ kind: 'item.hide', id, hidden });
export const heartItem = (id: string, on: boolean) => enqueue({ kind: 'item.heart', id, on });
/** The viewer's own order for a list, first to last; [] resets it. */
export const orderList = (listId: string, ids: string[]) =>
  enqueue({ kind: 'list.order', id: listId, ids });

export function logDone(
  itemId: string,
  entry: { done_on: string; note: string; rating: number | null; visibility?: Visibility },
): Promise<string> {
  const id = ulid();
  return enqueue({ kind: 'log.create', id, item_id: itemId, ...entry }).then(() => id);
}
export const updateLogEntry = (id: string, patch: Extract<Op, { kind: 'log.update' }>['patch']) =>
  enqueue({ kind: 'log.update', id, patch });
export const deleteLogEntry = (id: string) => enqueue({ kind: 'log.delete', id });

export function createList(name: string): Promise<string> {
  const id = ulid();
  return enqueue({ kind: 'list.create', id, name }).then(() => id);
}
export const renameList = (id: string, name: string) => enqueue({ kind: 'list.update', id, name });
export const updateMembership = (
  id: string,
  patch: { include_in_suggestions?: boolean; log_visibility?: Visibility },
) => enqueue({ kind: 'list.membership', id, ...patch });
