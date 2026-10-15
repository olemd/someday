// SPDX-License-Identifier: AGPL-3.0-or-later
/** Lists overview and one list's ideas with search and filters (§3, M2). */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Item } from '../../shared/schemas/items';
import { showError, toast } from '../components/Toast';
import { get, post } from '../lib/api';
import { createList, itemList, lists, newId, orderList, ready, saveItem, sync } from '../lib/data';
import { calendarDate } from '../lib/fmt';
import { t } from '../lib/i18n';
import { durationLabel, monthsLabel, statusLabel } from '../lib/labels';
import { navigate, query, route, setQuery } from '../lib/router';

/** Lists deleted in the last 30 days can be restored by their owner (§3.1). Online only. */
function DeletedLists() {
  const [deleted, setDeleted] = useState<{ id: string; name: string; deleted_at: string }[]>([]);
  const load = () => get<typeof deleted>('/lists/deleted').then(setDeleted, () => setDeleted([]));
  useEffect(() => void load(), []);
  if (!deleted.length) return null;
  return (
    <section class="panel stack" aria-labelledby="deleted-title">
      <h2 id="deleted-title">{t('lists.deletedTitle')}</h2>
      <ul class="plain stack tight">
        {deleted.map((l) => (
          <li key={l.id} class="row">
            <span>{l.name}</span>
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                try {
                  await post(`/lists/${l.id}/restore`);
                  await sync();
                  toast(t('lists.restored'));
                  void load();
                } catch (err) {
                  showError(err);
                }
              }}
            >
              {t('lists.restore')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ListsScreen() {
  const [name, setName] = useState('');
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of itemList.value) {
      if ((i.status === 'idea' || i.status === 'planned') && !i.hidden_at)
        m.set(i.list_id, (m.get(i.list_id) ?? 0) + 1);
    }
    return m;
  }, [itemList.value]);

  return (
    <div class="stack">
      <h1 tabIndex={-1}>{t('lists.title')}</h1>
      {!ready.value ? (
        <p>{t('app.loading')}</p>
      ) : (
        <ul class="plain list-cards">
          {lists.value.map((l) => (
            <li key={l.id}>
              <a class="list-card stack tight" href={`/lists/${l.id}`}>
                <strong>{l.name}</strong>
                <span class="meta">
                  <span>{t('lists.open', { count: counts.get(l.id) ?? 0 })}</span>
                  {l.member_count > 1 && (
                    <span>{t('lists.members', { count: l.member_count })}</span>
                  )}
                  {l.role !== 'owner' && <span>{t(`role.${l.role}`)}</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <form
        class="panel stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const id = await createList(name.trim());
            setName('');
            navigate(`/lists/${id}`);
          } catch (err) {
            showError(err);
          }
        }}
      >
        <div class="field">
          <label for="new-list">{t('lists.new')}</label>
          <div class="inline">
            <input
              id="new-list"
              value={name}
              maxLength={100}
              required
              placeholder={t('lists.newPlaceholder')}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <button type="submit" class="btn primary">
              {t('common.add')}
            </button>
          </div>
        </div>
      </form>
      <DeletedLists />
    </div>
  );
}

type Filter = 'open' | 'planned' | 'done' | 'archived' | 'all' | 'hidden';

function matches(i: Item, filter: Filter, q: string, tag: string | null): boolean {
  // Hidden for me: only under "Hidden" and "All".
  if (filter === 'hidden') {
    if (!i.hidden_at) return false;
  } else if (filter !== 'all' && i.hidden_at) return false;
  if (filter === 'open' && !(i.status === 'idea' || i.status === 'planned')) return false;
  if (filter === 'open' && !i.repeatable && i.done_for_me) return false;
  if (filter === 'planned' && i.status !== 'planned') return false;
  if (filter === 'done' && !(i.status === 'done' || i.done_for_me)) return false;
  if (filter === 'archived' && i.status !== 'archived') return false;
  if (tag && !i.tags.includes(tag)) return false;
  if (q) {
    const s = q.toLowerCase();
    if (
      !i.title.toLowerCase().includes(s) &&
      !i.notes.toLowerCase().includes(s) &&
      !i.tags.some((x) => x.includes(s))
    ) {
      return false;
    }
  }
  return true;
}

/** Default order: planned first, then newest first. */
function byDefault(a: Item, b: Item): number {
  const rank = (i: Item) => (i.status === 'planned' ? 0 : 1);
  return rank(a) - rank(b) || b.created_at.localeCompare(a.created_at);
}

/**
 * The viewer's own order: ideas they have not placed yet come first (so a new
 * idea shows at the top), in the default order; then the placed ones.
 */
export function byPosition(a: Item, b: Item): number {
  if (a.position === null && b.position === null) return byDefault(a, b);
  if (a.position === null) return -1;
  if (b.position === null) return 1;
  return a.position - b.position;
}

/**
 * One idea in a list: the title and at most two short facts (state, hearts,
 * and one hint of when or how long, in that priority). Everything else is on
 * the idea's own page.
 */
export function ItemRow({ item }: { item: Item }) {
  const doneForMe = item.done_for_me && item.status !== 'done';
  const hint = item.duration ? durationLabel(item.duration) : monthsLabel(item.months);
  const facts = [
    item.hidden_at ? (
      <span class="badge">{t('item.hidden')}</span>
    ) : item.status !== 'idea' ? (
      <span class={`badge status-${item.status}`}>{statusLabel(item.status)}</span>
    ) : (
      doneForMe && (
        <span class="badge status-done">
          {item.my_last_done_on
            ? t('item.doneOn', { date: calendarDate(item.my_last_done_on) })
            : t('item.doneForMe')}
        </span>
      )
    ),
    item.hearted_by.length > 0 && (
      <span>
        <span aria-hidden="true">♥ {item.hearted_by.length}</span>
        <span class="visually-hidden">{t('item.hearts', { count: item.hearted_by.length })}</span>
      </span>
    ),
    hint && <span>{hint}</span>,
  ]
    .filter(Boolean)
    .slice(0, 2);
  return (
    <a class="item-row" href={`/items/${item.id}`}>
      <span class="stack tight grow">
        <span class="item-title">{item.title}</span>
        {facts.length > 0 && <span class="meta">{facts}</span>}
      </span>
    </a>
  );
}

/**
 * Moving one idea in the viewer's own order. Moves are relative to what is
 * shown (the filter may hide ideas in between), applied to the whole list.
 */
function OrderControls(props: {
  item: Item;
  index: number;
  shown: Item[];
  all: Item[];
  listId: string;
  announce: (text: string) => void;
}) {
  const { item, index, shown } = props;
  /** Put `item` at place `to` among the shown ideas (0 = first). */
  const move = async (to: number) => {
    const rest = props.all.filter((i) => i.id !== item.id);
    const others = shown.filter((i) => i.id !== item.id);
    const anchor = others[to];
    const at = anchor ? rest.indexOf(anchor) : rest.indexOf(others[others.length - 1]!) + 1;
    rest.splice(at, 0, item);
    await orderList(
      props.listId,
      rest.map((i) => i.id),
    );
    props.announce(t('lists.moved', { title: item.title, pos: to + 1, total: shown.length }));
  };
  return (
    <span class="order-controls">
      <button
        type="button"
        class="btn plain small"
        disabled={index === 0}
        aria-label={t('lists.moveTop', { title: item.title })}
        onClick={() => move(0)}
      >
        <span aria-hidden="true">⤒</span>
      </button>
      <button
        type="button"
        class="btn plain small"
        disabled={index === 0}
        aria-label={t('lists.moveUp', { title: item.title })}
        onClick={() => move(index - 1)}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        class="btn plain small"
        disabled={index === shown.length - 1}
        aria-label={t('lists.moveDown', { title: item.title })}
        onClick={() => move(index + 1)}
      >
        <span aria-hidden="true">↓</span>
      </button>
    </span>
  );
}

export function ListScreen() {
  const id = route.value.split('/')[2] ?? '';
  const list = lists.value.find((l) => l.id === id);
  const filter = (query.value.get('show') as Filter) || 'open';
  const q = query.value.get('q') ?? '';
  const tag = query.value.get('tag');
  const [title, setTitle] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const all = itemList.value.filter((i) => i.list_id === id).sort(byPosition);
  const shown = all.filter((i) => matches(i, filter, q, tag));
  const hiddenCount = all.filter((i) => i.hidden_at).length;
  const tags = [...new Set(all.flatMap((i) => i.tags))].sort();

  if (!ready.value) return <p>{t('app.loading')}</p>;
  if (!list) {
    return (
      <div class="stack">
        <h1 tabIndex={-1}>{t('lists.notFound')}</h1>
        <a href="/lists">{t('lists.back')}</a>
      </div>
    );
  }
  const canEdit = list.role !== 'viewer';
  const params = (over: Record<string, string | null>) => ({
    show: filter === 'open' ? null : filter,
    q: q || null,
    tag,
    ...over,
  });

  return (
    <div class="stack">
      <div class="page-head">
        <h1 tabIndex={-1}>{list.name}</h1>
        <a class="btn plain small" href={`/lists/${id}/settings`}>
          {t('lists.settings')}
        </a>
      </div>
      {canEdit && (
        <form
          class="quick-add"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await saveItem(newId(), { list_id: id, title: title.trim() });
            setTitle('');
          }}
        >
          <label class="visually-hidden" for="quick-add">
            {t('lists.quickAdd')}
          </label>
          <input
            id="quick-add"
            value={title}
            maxLength={200}
            placeholder={t('lists.quickAddPlaceholder')}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
          <button type="submit" class="btn primary">
            {t('common.add')}
          </button>
          <a class="btn plain" href={`/items/new?list=${id}`}>
            {t('lists.addDetailed')}
          </a>
        </form>
      )}
      <div class="row">
        <nav class="tabs" aria-label={t('lists.filterLabel')}>
          {(
            [
              'open',
              'planned',
              'done',
              'archived',
              'all',
              ...(hiddenCount > 0 || filter === 'hidden' ? (['hidden'] as const) : []),
            ] as const
          ).map((f) => (
            <a
              key={f}
              href={`/lists/${id}${f === 'open' ? '' : `?show=${f}`}`}
              aria-current={filter === f ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setQuery(params({ show: f === 'open' ? null : f }));
              }}
            >
              {t(`lists.show_${f}`)}
            </a>
          ))}
        </nav>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="list-q">{t('lists.search')}</label>
          <input
            id="list-q"
            type="search"
            value={q}
            onInput={(e) => setQuery(params({ q: e.currentTarget.value || null }))}
          />
        </div>
        {tags.length > 0 && (
          <div class="field">
            <label for="list-tag">{t('lists.tag')}</label>
            <select
              id="list-tag"
              value={tag ?? ''}
              onChange={(e) => setQuery(params({ tag: e.currentTarget.value || null }))}
            >
              <option value="">{t('lists.anyTag')}</option>
              {tags.map((x) => (
                <option key={x} value={x}>
                  #{x}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div class="row">
        <p class="muted small" role="status">
          {announcement || t('lists.showing', { count: shown.length })}
        </p>
        {shown.length > 1 && (
          <button
            type="button"
            class="btn plain small"
            aria-pressed={ordering}
            onClick={() => {
              setOrdering(!ordering);
              setAnnouncement('');
            }}
          >
            {ordering ? t('lists.reorderDone') : t('lists.reorder')}
          </button>
        )}
      </div>
      {ordering && (
        <p class="muted small">
          {t('lists.orderHint')}{' '}
          {all.some((i) => i.position !== null) && (
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                await orderList(id, []);
                setAnnouncement(t('lists.orderReset'));
              }}
            >
              {t('lists.resetOrder')}
            </button>
          )}
        </p>
      )}
      {shown.length === 0 ? (
        <p class="empty">{all.length ? t('lists.noMatch') : t('lists.empty')}</p>
      ) : (
        <ul class="plain items panel">
          {shown.map((i, index) => (
            <li key={i.id} class={ordering ? 'ordering' : undefined}>
              <ItemRow item={i} />
              {ordering && (
                <OrderControls
                  item={i}
                  index={index}
                  shown={shown}
                  all={all}
                  listId={id}
                  announce={setAnnouncement}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
