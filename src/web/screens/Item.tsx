// SPDX-License-Identifier: AGPL-3.0-or-later
/** One idea: details, edit, status, "done" log with undo (§3.2, §3.3). */
import { useEffect, useState } from 'preact/hooks';
import { get } from '../lib/api';
import type { LogEntry } from '../../shared/schemas/items';
import { confirmAction } from '../components/Dialog';
import { openDoneDialog } from '../components/DoneDialog';
import { blankDraft, ItemForm, type ItemDraft } from '../components/ItemForm';
import { toast } from '../components/Toast';
import {
  deleteItem,
  deleteLogEntry,
  items,
  listById,
  lists,
  logs,
  newId,
  ready,
  saveItem,
  snoozeItem,
  updateLogEntry,
} from '../lib/data';
import { calendarDate, dateTime } from '../lib/fmt';
import { t } from '../lib/i18n';
import {
  costLabel,
  durationLabel,
  energyLabel,
  monthsLabel,
  settingLabel,
  socialLabel,
  statusLabel,
} from '../lib/labels';
import { Markdown } from '../lib/markdown';
import { navigate, query, route } from '../lib/router';

/** Fields of a draft that differ from the stored item (only those are sent). */
function diff(before: ItemDraft, after: ItemDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(after) as (keyof ItemDraft)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  }
  return out;
}

export function NewItemScreen() {
  const listId = query.value.get('list') ?? lists.value.find((l) => l.role !== 'viewer')?.id ?? '';
  if (!ready.value) return <p>{t('app.loading')}</p>;
  return (
    <div class="stack">
      <h1 tabIndex={-1}>{t('item.newTitle')}</h1>
      <ItemForm
        initial={blankDraft(listId)}
        submitLabel={t('item.create')}
        onCancel={() => history.back()}
        onSubmit={async (d) => {
          const id = newId();
          await saveItem(id, d as unknown as Record<string, unknown>);
          toast(t('item.created'));
          navigate(`/items/${id}`, true);
        }}
      />
    </div>
  );
}

function LogList({ entries, canLog }: { entries: LogEntry[]; canLog: boolean }) {
  if (!entries.length) return canLog ? <p class="muted">{t('item.noLog')}</p> : null;
  return (
    <ul class="plain stack tight">
      {entries.map((e) => (
        <li key={e.id} class="panel stack tight">
          <div class="row">
            <strong>
              {calendarDate(e.done_on)}
              {e.rating ? ` · ${t('done.stars', { count: e.rating })}` : ''}
            </strong>
            <span class="muted small">
              {e.mine ? t(`visibility.${e.visibility}`) : e.user_name}
            </span>
          </div>
          {e.note && <Markdown text={e.note} />}
          {e.mine && (
            <div class="actions">
              <label class="visually-hidden" for={`vis-${e.id}`}>
                {t('done.visibility')}
              </label>
              <select
                id={`vis-${e.id}`}
                value={e.visibility}
                onChange={(ev) =>
                  updateLogEntry(e.id, {
                    visibility: ev.currentTarget.value as LogEntry['visibility'],
                  })
                }
              >
                {(['private', 'anonymous', 'shared'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t(`visibility.${v}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                class="btn plain small"
                onClick={async () => {
                  if (await confirmAction(t('item.undoConfirm'), t('item.undo'))) {
                    await deleteLogEntry(e.id);
                    toast(t('item.undone'));
                  }
                }}
              >
                {t('item.undo')}
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

interface HistoryRow {
  at: string;
  op: string;
  by: string | null;
  via: string | null;
}

/** Who changed this idea (and "via <app>" for changes made through MCP, §8.2). Online only. */
function History({ id }: { id: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState(false);
  // Fetched when opened: a just-created idea may still be waiting in the outbox.
  const load = () => get<HistoryRow[]>(`/items/${id}/history`).then(setRows, () => setError(true));
  useEffect(() => {
    setRows(null);
    setError(false);
  }, [id]);
  return (
    <details onToggle={(e) => e.currentTarget.open && rows === null && void load()}>
      <summary>{t('item.history')}</summary>
      {error && <p class="muted small">{t('item.historyUnavailable')}</p>}
      {rows && (
        <ul class="plain stack tight small">
          {rows.map((r, i) => (
            <li key={i}>
              {dateTime(r.at)} · {r.by ?? t('item.someone')}
              {r.via && ` ${t('item.via', { app: r.via })}`}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function ItemScreen() {
  const id = route.value.split('/')[2] ?? '';
  const item = items.value.get(id);
  const [editing, setEditing] = useState(false);

  if (!ready.value) return <p>{t('app.loading')}</p>;
  if (!item) {
    return (
      <div class="stack">
        <h1 tabIndex={-1}>{t('item.notFound')}</h1>
        <a href="/lists">{t('lists.back')}</a>
      </div>
    );
  }
  const list = listById.value.get(item.list_id);
  const canEdit = list?.role !== 'viewer';
  const shared = (list?.member_count ?? 1) > 1;
  const entries = logs.value
    .filter((e) => e.item_id === id)
    .sort((a, b) => b.done_on.localeCompare(a.done_on));
  const { id: _id, ...rest } = item;
  const draft: ItemDraft = {
    list_id: rest.list_id,
    title: rest.title,
    notes: rest.notes,
    status: rest.status,
    repeatable: rest.repeatable,
    duration: rest.duration,
    setting: rest.setting,
    cost: rest.cost,
    energy: rest.energy,
    social: rest.social,
    valid_from: rest.valid_from,
    valid_to: rest.valid_to,
    months: rest.months,
    links: rest.links,
    location: rest.location,
    tags: rest.tags,
  };

  if (editing) {
    return (
      <div class="stack">
        <h1 tabIndex={-1}>{t('item.editTitle')}</h1>
        <ItemForm
          initial={draft}
          submitLabel={t('common.save')}
          onCancel={() => setEditing(false)}
          onSubmit={async (d) => {
            const changes = diff(draft, d);
            if (Object.keys(changes).length) await saveItem(id, changes);
            toast(t('common.saved'));
            setEditing(false);
          }}
        />
      </div>
    );
  }

  /** On shared lists, changing status affects everyone: confirm first (§3.3). */
  const setStatus = async (status: typeof item.status) => {
    if (
      shared &&
      (status === 'done' || status === 'archived') &&
      !(await confirmAction(
        t('item.forEveryoneConfirm', { status: statusLabel(status) }),
        t('common.confirm'),
      ))
    ) {
      return;
    }
    await saveItem(id, { status });
  };

  const details: [string, string][] = [];
  if (item.duration) details.push([t('item.duration'), durationLabel(item.duration)]);
  if (item.setting) details.push([t('item.setting'), settingLabel(item.setting)]);
  if (item.cost !== null) details.push([t('item.cost'), costLabel(item.cost)]);
  if (item.energy) details.push([t('item.energy'), energyLabel(item.energy)]);
  if (item.social) details.push([t('item.social'), socialLabel(item.social)]);
  if (item.valid_from || item.valid_to) {
    details.push([
      t('item.window'),
      [
        item.valid_from && t('item.from', { date: calendarDate(item.valid_from) }),
        item.valid_to && t('item.until', { date: calendarDate(item.valid_to) }),
      ]
        .filter(Boolean)
        .join(' '),
    ]);
  }
  if (item.months) details.push([t('item.months'), monthsLabel(item.months)]);
  if (item.location) details.push([t('item.location'), item.location.label]);
  const snoozed = item.snoozed_until && Date.parse(item.snoozed_until) > Date.now();

  return (
    <div class="stack">
      <p class="small">
        <a href={`/lists/${item.list_id}`}>← {list?.name ?? t('lists.title')}</a>
      </p>
      <div class="page-head">
        <h1 tabIndex={-1}>{item.title}</h1>
        <span class={`badge status-${item.status}`}>{statusLabel(item.status)}</span>
      </div>
      {item.tags.length > 0 && (
        <p class="tags">
          {item.tags.map((x) => (
            <a class="tag" key={x} href={`/lists/${item.list_id}?tag=${encodeURIComponent(x)}`}>
              #{x}
            </a>
          ))}
        </p>
      )}
      {item.notes && <Markdown text={item.notes} />}
      {item.links.length > 0 && (
        <ul>
          {item.links.map((l) => (
            <li key={l.url}>
              <a href={l.url} rel="noopener noreferrer" target="_blank">
                {l.label || l.url}
              </a>
            </li>
          ))}
        </ul>
      )}
      {details.length > 0 && (
        <dl class="grid-2">
          {details.map(([k, v]) => (
            <div key={k}>
              <dt class="muted small">{k}</dt>
              <dd class="flush">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {shared && (item.done_count !== null || item.done_by.length > 0) && (
        <p class="muted">
          {item.done_count !== null ? t('item.doneCount', { count: item.done_count }) : ''}
          {item.done_by.length > 0 && ` ${t('item.doneBy', { names: item.done_by.join(', ') })}`}
        </p>
      )}
      {item.repeatable && <p class="muted small">{t('item.repeatableNote')}</p>}
      {snoozed && (
        <p class="notice">
          {t('item.snoozedUntil', { date: dateTime(item.snoozed_until!) })}{' '}
          <button type="button" class="btn plain small" onClick={() => snoozeItem(id, null)}>
            {t('item.unsnooze')}
          </button>
        </p>
      )}

      <div class="actions start">
        <button type="button" class="btn primary" onClick={() => openDoneDialog(item)}>
          {t('item.markDone')}
        </button>
        {canEdit && item.status === 'idea' && (
          <button type="button" class="btn plain" onClick={() => setStatus('planned')}>
            {t('suggest.letsDoIt')}
          </button>
        )}
        {canEdit && (item.status === 'done' || item.status === 'archived') && (
          <button type="button" class="btn plain" onClick={() => setStatus('idea')}>
            {t('item.reopen')}
          </button>
        )}
        {canEdit && shared && item.status !== 'done' && (
          <button type="button" class="btn plain" onClick={() => setStatus('done')}>
            {t('item.doneForEveryone')}
          </button>
        )}
        {canEdit && item.status !== 'archived' && (
          <button type="button" class="btn plain" onClick={() => setStatus('archived')}>
            {t('item.archive')}
          </button>
        )}
        {canEdit && (
          <button type="button" class="btn plain" onClick={() => setEditing(true)}>
            {t('common.edit')}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            class="btn danger-plain"
            onClick={async () => {
              if (
                !(await confirmAction(
                  t('item.deleteConfirm', { title: item.title }),
                  t('common.delete'),
                  true,
                ))
              )
                return;
              await deleteItem(id);
              navigate(`/lists/${item.list_id}`, true);
            }}
          >
            {t('common.delete')}
          </button>
        )}
      </div>

      <section class="stack" aria-labelledby="log-title">
        <h2 id="log-title">{t('item.log')}</h2>
        <LogList entries={entries} canLog />
      </section>
      <History id={id} />
    </div>
  );
}
