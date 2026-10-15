// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Give me something" (§4): quick filter chips, one big button, and a
 * suggestion that always says why. Actions: Let's do it, Done, Not now,
 * Never, Another one. Works offline by running the same pure suggester
 * locally on the IndexedDB mirror.
 */
import { useState } from 'preact/hooks';
import { cryptoRng, type Reason, weightedSuggest } from '../../core/suggest';
import type { Item } from '../../shared/schemas/items';
import { renderReasons } from '../../shared/i18n/reasons';
import { openDoneDialog } from '../components/DoneDialog';
import { Icon } from '../components/Icons';
import { showError, toast } from '../components/Toast';
import { NetworkError, patch, post } from '../lib/api';
import {
  itemList,
  items,
  listById,
  lists,
  markSeen,
  ready,
  saveItem,
  snoozeItem,
  sync,
} from '../lib/data';
import { today } from '../lib/fmt';
import { t, translator } from '../lib/i18n';
import {
  COSTS,
  contextSummary,
  costLabel,
  DURATIONS,
  durationLabel,
  ENERGIES,
  energyLabel,
} from '../lib/labels';
import { Markdown } from '../lib/markdown';
import { auth, settings, type Settings, type SuggestFilters } from '../lib/store';

interface Shown {
  item: Item;
  reasons: string[];
}

/** A group of single-choice chips; choosing the active chip again clears it. */
function ChipGroup<T extends string | number>(props: {
  legend: string;
  name: string;
  value: T | undefined;
  options: readonly T[];
  label: (v: T) => string;
  onChange: (v: T | undefined) => void;
}) {
  return (
    <fieldset class="chips">
      <legend>{props.legend}</legend>
      {props.options.map((o) => (
        <label class="chip" key={String(o)}>
          <input
            type="checkbox"
            name={props.name}
            checked={props.value === o}
            onChange={(e) => props.onChange(e.currentTarget.checked ? o : undefined)}
          />
          <span>{props.label(o)}</span>
        </label>
      ))}
    </fieldset>
  );
}

function Filters({ f, set }: { f: SuggestFilters; set: (f: SuggestFilters) => void }) {
  const included = lists.value.filter((l) => l.include_in_suggestions).map((l) => l.id);
  const chosen = f.list_ids ?? included;
  return (
    <details class="panel">
      <summary>{t('suggest.filters')}</summary>
      <div class="stack">
        <ChipGroup
          legend={t('suggest.time')}
          name="time"
          value={f.max_duration}
          options={DURATIONS}
          label={durationLabel}
          onChange={(v) => set({ ...f, max_duration: v })}
        />
        <ChipGroup
          legend={t('suggest.where')}
          name="setting"
          value={f.setting}
          options={['indoor', 'outdoor'] as const}
          label={(s) => t(`setting.${s}`)}
          onChange={(v) => set({ ...f, setting: v })}
        />
        <ChipGroup
          legend={t('suggest.budget')}
          name="cost"
          value={f.max_cost}
          options={COSTS}
          label={costLabel}
          onChange={(v) => set({ ...f, max_cost: v })}
        />
        <ChipGroup
          legend={t('suggest.energy')}
          name="energy"
          value={f.energy}
          options={ENERGIES}
          label={energyLabel}
          onChange={(v) => set({ ...f, energy: v })}
        />
        <ChipGroup
          legend={t('suggest.with')}
          name="social"
          value={f.social}
          options={['solo', 'together'] as const}
          label={(s) => t(`social.${s}`)}
          onChange={(v) => set({ ...f, social: v })}
        />
        {lists.value.length > 1 && (
          <fieldset class="chips">
            <legend>{t('suggest.lists')}</legend>
            {lists.value.map((l) => (
              <label class="chip" key={l.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(l.id)}
                  onChange={(e) => {
                    const next = e.currentTarget.checked
                      ? [...chosen, l.id]
                      : chosen.filter((x) => x !== l.id);
                    set({ ...f, list_ids: next });
                  }}
                />
                <span>{l.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        <div class="actions start">
          <button type="button" class="btn plain small" onClick={() => set({})}>
            {t('suggest.clear')}
          </button>
          <button
            type="button"
            class="btn plain small"
            onClick={async () => {
              try {
                settings.value = await patch<Settings>('/settings', { suggest_filters: f });
                toast(t('suggest.savedDefault'));
              } catch (err) {
                showError(err);
              }
            }}
          >
            {t('suggest.saveDefault')}
          </button>
        </div>
      </div>
    </details>
  );
}

export function HomeScreen() {
  const [filters, setFilters] = useState<SuggestFilters>(settings.value?.suggest_filters ?? {});
  const [shown, setShown] = useState<Shown | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Ask the server; offline, run the same suggester locally. */
  const suggest = async (exclude: string[]) => {
    setBusy(true);
    setEmpty(false);
    try {
      await sync();
      let result: Shown | null;
      try {
        const r = await post<{
          suggestion: { item: Item; reason_texts: string[] } | null;
        }>('/suggest', { filters, exclude });
        result = r.suggestion
          ? { item: r.suggestion.item, reasons: r.suggestion.reason_texts }
          : null;
        // Keep the local mirror's "last suggested" in step without another round trip.
        if (r.suggestion) {
          const local = items.value.get(r.suggestion.item.id);
          if (local) items.value = new Map(items.value).set(local.id, r.suggestion.item);
        }
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
        const listIds =
          filters.list_ids ?? lists.value.filter((l) => l.include_in_suggestions).map((l) => l.id);
        const pick = weightedSuggest({
          items: itemList.value,
          now: Date.now(),
          today: today(),
          filters: { ...filters, list_ids: listIds },
          exclude,
          rng: cryptoRng,
        });
        result = pick
          ? {
              item: pick.item,
              reasons: renderReasons(translator.value.t, pick.reasons as Reason[]),
            }
          : null;
        if (pick) await markSeen(pick.item.id);
      }
      setShown(result);
      setEmpty(!result);
      if (result) setSeen([...exclude, result.item.id]);
      queueMicrotask(() => document.getElementById('suggestion-title')?.focus());
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const next = () => suggest(seen);
  const item = shown ? (items.value.get(shown.item.id) ?? shown.item) : null;
  const list = item ? listById.value.get(item.list_id) : undefined;
  const canEdit = list?.role !== 'viewer';

  return (
    <div class="stack">
      <h1 tabIndex={-1}>{t('home.greeting', { name: auth.value?.user?.display_name ?? '' })}</h1>
      <Filters f={filters} set={setFilters} />
      <div class="hero">
        <button
          type="button"
          class="btn sun"
          disabled={busy || !ready.value}
          onClick={() => suggest(item ? seen : [])}
        >
          <Icon name="sun" />
          {item ? t('suggest.another') : t('suggest.button')}
        </button>
      </div>
      <div aria-live="polite">
        {empty && (
          <p class="empty">
            {seen.length ? t('suggest.noMore') : t('suggest.nothing')}{' '}
            {seen.length > 0 && (
              <button type="button" class="btn plain small" onClick={() => suggest([])}>
                {t('suggest.startOver')}
              </button>
            )}
          </p>
        )}
        {item && shown && (
          <article class="panel suggestion stack" aria-labelledby="suggestion-title">
            <p class="muted small">{list?.name}</p>
            <h2 id="suggestion-title" tabIndex={-1}>
              <a href={`/items/${item.id}`}>{item.title}</a>
            </h2>
            {contextSummary(item).length > 0 && (
              <p class="meta">{contextSummary(item).join(' · ')}</p>
            )}
            {item.notes && <Markdown text={item.notes.slice(0, 600)} />}
            <h3 class="visually-hidden">{t('suggest.why')}</h3>
            <ul class="reasons">
              {shown.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div class="actions start">
              {canEdit && item.status !== 'planned' && (
                <button
                  type="button"
                  class="btn primary"
                  onClick={async () => {
                    await saveItem(item.id, { status: 'planned' });
                    toast(t('suggest.planned'));
                  }}
                >
                  {t('suggest.letsDoIt')}
                </button>
              )}
              <button
                type="button"
                class="btn plain"
                onClick={async () => {
                  if (await openDoneDialog(item)) setShown(null);
                }}
              >
                {t('item.markDone')}
              </button>
              <button
                type="button"
                class="btn plain"
                onClick={async () => {
                  const days = settings.value?.snooze_days ?? 7;
                  await snoozeItem(item.id, new Date(Date.now() + days * 86_400_000).toISOString());
                  toast(t('suggest.snoozed', { count: days }));
                  void next();
                }}
              >
                {t('suggest.notNow')}
              </button>
              {canEdit && (
                <button
                  type="button"
                  class="btn plain"
                  onClick={async () => {
                    await saveItem(item.id, { status: 'archived' });
                    toast(t('suggest.never'), {
                      action: {
                        label: t('common.undo'),
                        run: () => void saveItem(item.id, { status: item.status }),
                      },
                    });
                    void next();
                  }}
                >
                  {t('suggest.neverButton')}
                </button>
              )}
              <button type="button" class="btn plain" onClick={next} disabled={busy}>
                {t('suggest.another')}
              </button>
            </div>
          </article>
        )}
      </div>
      {ready.value && itemList.value.length === 0 && (
        <p class="empty">
          {t('home.emptyIntro')} <a href="/items/new">{t('home.addFirst')}</a>
        </p>
      )}
    </div>
  );
}
