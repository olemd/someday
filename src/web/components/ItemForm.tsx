// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Create or edit an idea (§3.2). Only the title is required; every context
 * field is optional and "not set" matches any filter in suggestions.
 */
import { useState } from 'preact/hooks';
import type { Item } from '../../shared/schemas/items';
import { lists } from '../lib/data';
import { monthName } from '../lib/fmt';
import { t } from '../lib/i18n';
import {
  COSTS,
  costLabel,
  DURATIONS,
  durationLabel,
  ENERGIES,
  energyLabel,
  SETTINGS,
  settingLabel,
  SOCIALS,
  socialLabel,
  STATUSES,
  statusLabel,
} from '../lib/labels';

export type ItemDraft = Omit<
  Item,
  | 'id'
  | 'created_by'
  | 'created_at'
  | 'updated_at'
  | 'done_for_me'
  | 'my_last_done_on'
  | 'snoozed_until'
  | 'last_suggested_at'
  | 'done_count'
  | 'done_by'
>;

export function blankDraft(listId: string): ItemDraft {
  return {
    list_id: listId,
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
  };
}

/** A <select> for an optional enum: the empty option means "not set". */
function OptSelect<T extends string | number>(props: {
  id: string;
  label: string;
  value: T | null;
  options: readonly T[];
  text: (v: T) => string;
  onChange: (v: T | null) => void;
}) {
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      <select
        id={props.id}
        value={props.value === null ? '' : String(props.value)}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          if (raw === '') return props.onChange(null);
          const v = props.options.find((o) => String(o) === raw);
          props.onChange(v ?? null);
        }}
      >
        <option value="">{t('item.notSet')}</option>
        {props.options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {props.text(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ItemForm(props: {
  initial: ItemDraft;
  submitLabel: string;
  onSubmit: (d: ItemDraft) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<ItemDraft>(props.initial);
  const [tags, setTags] = useState(props.initial.tags.join(', '));
  const [error, setError] = useState('');
  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const editable = lists.value.filter((l) => l.role !== 'viewer');

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (d.valid_from && d.valid_to && d.valid_from > d.valid_to) {
          setError(t('item.badWindow'));
          return;
        }
        const links = d.links.filter((l) => l.url.trim());
        if (links.some((l) => !/^https?:\/\//i.test(l.url.trim()))) {
          setError(t('item.badLink'));
          return;
        }
        setError('');
        await props.onSubmit({
          ...d,
          title: d.title.trim(),
          links: links.map((l) => ({
            url: l.url.trim(),
            ...(l.label?.trim() ? { label: l.label.trim() } : {}),
          })),
          tags: tags
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        });
      }}
    >
      <div class="field">
        <label for="f-title">{t('item.title')}</label>
        <input
          id="f-title"
          value={d.title}
          maxLength={200}
          required
          onInput={(e) => set('title', e.currentTarget.value)}
        />
      </div>
      <div class="field">
        <label for="f-notes">
          {t('item.notes')} <span class="muted">({t('common.optional')})</span>
        </label>
        <textarea
          id="f-notes"
          maxLength={20000}
          value={d.notes}
          onInput={(e) => set('notes', e.currentTarget.value)}
        />
        <span class="hint">{t('item.notesHint')}</span>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="f-list">{t('item.list')}</label>
          <select
            id="f-list"
            value={d.list_id}
            onChange={(e) => set('list_id', e.currentTarget.value)}
          >
            {editable.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="f-status">{t('item.status')}</label>
          <select
            id="f-status"
            value={d.status}
            onChange={(e) => set('status', e.currentTarget.value as Item['status'])}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={d.repeatable}
          onChange={(e) => set('repeatable', e.currentTarget.checked)}
        />
        {t('item.repeatable')}
      </label>

      <fieldset class="panel stack">
        <legend>{t('item.context')}</legend>
        <p class="hint">{t('item.contextHint')}</p>
        <div class="grid-2">
          <OptSelect
            id="f-dur"
            label={t('item.duration')}
            value={d.duration}
            options={DURATIONS}
            text={durationLabel}
            onChange={(v) => set('duration', v)}
          />
          <OptSelect
            id="f-set"
            label={t('item.setting')}
            value={d.setting}
            options={SETTINGS}
            text={settingLabel}
            onChange={(v) => set('setting', v)}
          />
          <OptSelect
            id="f-cost"
            label={t('item.cost')}
            value={d.cost}
            options={COSTS}
            text={costLabel}
            onChange={(v) => set('cost', v)}
          />
          <OptSelect
            id="f-energy"
            label={t('item.energy')}
            value={d.energy}
            options={ENERGIES}
            text={energyLabel}
            onChange={(v) => set('energy', v)}
          />
          <OptSelect
            id="f-social"
            label={t('item.social')}
            value={d.social}
            options={SOCIALS}
            text={socialLabel}
            onChange={(v) => set('social', v)}
          />
        </div>
      </fieldset>

      <fieldset class="panel stack">
        <legend>{t('item.when')}</legend>
        <div class="grid-2">
          <div class="field">
            <label for="f-from">{t('item.validFrom')}</label>
            <input
              id="f-from"
              type="date"
              value={d.valid_from ?? ''}
              onInput={(e) => set('valid_from', e.currentTarget.value || null)}
            />
          </div>
          <div class="field">
            <label for="f-to">{t('item.validTo')}</label>
            <input
              id="f-to"
              type="date"
              value={d.valid_to ?? ''}
              onInput={(e) => set('valid_to', e.currentTarget.value || null)}
            />
          </div>
        </div>
        <fieldset class="chips">
          <legend>{t('item.months')}</legend>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
            const bit = 1 << (m - 1);
            return (
              <label class="chip" key={m}>
                <input
                  type="checkbox"
                  checked={!!((d.months ?? 0) & bit)}
                  onChange={(e) => {
                    const next = e.currentTarget.checked
                      ? (d.months ?? 0) | bit
                      : (d.months ?? 0) & ~bit;
                    set('months', next || null);
                  }}
                />
                <span>{monthName(m)}</span>
              </label>
            );
          })}
        </fieldset>
        <span class="hint">{t('item.monthsHint')}</span>
      </fieldset>

      <fieldset class="panel stack">
        <legend>{t('item.more')}</legend>
        <div class="field">
          <label for="f-tags">{t('item.tags')}</label>
          <input id="f-tags" value={tags} onInput={(e) => setTags(e.currentTarget.value)} />
          <span class="hint">{t('item.tagsHint')}</span>
        </div>
        <div class="field">
          <label for="f-loc">{t('item.location')}</label>
          <input
            id="f-loc"
            value={d.location?.label ?? ''}
            maxLength={200}
            onInput={(e) => {
              const label = e.currentTarget.value;
              set('location', label.trim() ? { ...(d.location ?? {}), label } : null);
            }}
          />
        </div>
        <div class="stack tight">
          <span class="field">
            <span>
              <strong>{t('item.links')}</strong>
            </span>
          </span>
          {d.links.map((l, i) => (
            <div class="grid-2" key={i}>
              <div class="field">
                <label for={`f-link-${i}`}>{t('item.linkUrl')}</label>
                <input
                  id={`f-link-${i}`}
                  type="url"
                  value={l.url}
                  onInput={(e) => {
                    const links = [...d.links];
                    links[i] = { ...l, url: e.currentTarget.value };
                    set('links', links);
                  }}
                />
              </div>
              <div class="field">
                <label for={`f-linkl-${i}`}>{t('item.linkLabel')}</label>
                <div class="inline">
                  <input
                    id={`f-linkl-${i}`}
                    value={l.label ?? ''}
                    onInput={(e) => {
                      const links = [...d.links];
                      links[i] = { ...l, label: e.currentTarget.value };
                      set('links', links);
                    }}
                  />
                  <button
                    type="button"
                    class="btn plain small"
                    onClick={() =>
                      set(
                        'links',
                        d.links.filter((_, j) => j !== i),
                      )
                    }
                  >
                    {t('common.remove')}
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              class="btn plain small"
              onClick={() => set('links', [...d.links, { url: 'https://' }])}
            >
              {t('item.addLink')}
            </button>
          </div>
        </div>
      </fieldset>

      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      <div class="actions">
        {props.onCancel && (
          <button type="button" class="btn plain" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" class="btn primary">
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}
