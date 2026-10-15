// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Done" (§3.3): when, a note, a rating, and — on shared lists — who may see
 * it. Private is the safe default; the last choice per list is remembered.
 * Anonymous is greyed out with an explanation when the list is too small.
 */
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Item, Visibility } from '../../shared/schemas/items';
import { listById, logDone } from '../lib/data';
import { today } from '../lib/fmt';
import { t } from '../lib/i18n';
import { toast } from './Toast';

const current = signal<{ item: Item; resolve: (done: boolean) => void } | null>(null);

/** Open the dialog; resolves true when an entry was logged. */
export function openDoneDialog(item: Item): Promise<boolean> {
  return new Promise((resolve) => {
    current.value = { item, resolve };
  });
}

function Form({ item, close }: { item: Item; close: (done: boolean) => void }) {
  const list = listById.value.get(item.list_id);
  const shared = (list?.member_count ?? 1) > 1;
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [visibility, setVisibility] = useState<Visibility>(
    list?.log_visibility === 'anonymous' && !list.anonymous_available
      ? 'private'
      : (list?.log_visibility ?? 'private'),
  );

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        await logDone(item.id, {
          done_on: date,
          note: note.trim(),
          rating,
          visibility: shared ? visibility : undefined,
        });
        toast(t('done.logged', { title: item.title }));
        close(true);
      }}
    >
      <h2 id="done-title" class="dialog-title">
        {t('done.title', { title: item.title })}
      </h2>
      <div class="field">
        <label for="done-date">{t('done.when')}</label>
        <input
          id="done-date"
          type="date"
          value={date}
          max={today()}
          required
          onInput={(e) => setDate(e.currentTarget.value)}
        />
      </div>
      <div class="field">
        <label for="done-note">
          {t('done.note')} <span class="muted">({t('common.optional')})</span>
        </label>
        <textarea
          id="done-note"
          maxLength={5000}
          value={note}
          onInput={(e) => setNote(e.currentTarget.value)}
        />
      </div>
      <fieldset class="chips">
        <legend>
          {t('done.rating')} <span class="muted">({t('common.optional')})</span>
        </legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label class="chip" key={n}>
            <input
              type="radio"
              name="rating"
              checked={rating === n}
              onClick={() => setRating(rating === n ? null : n)}
              onChange={() => undefined}
            />
            <span>{t('done.stars', { count: n })}</span>
          </label>
        ))}
      </fieldset>
      {shared && (
        <fieldset class="field">
          <legend>{t('done.visibility')}</legend>
          {(['private', 'anonymous', 'shared'] as const).map((v) => {
            const disabled = v === 'anonymous' && !list?.anonymous_available;
            return (
              <label class="radio" key={v}>
                <input
                  type="radio"
                  name="visibility"
                  value={v}
                  checked={visibility === v}
                  disabled={disabled}
                  aria-describedby={`vis-${v}-hint`}
                  onChange={() => setVisibility(v)}
                />
                <span>
                  {t(`visibility.${v}`)}
                  <br />
                  <span class="hint" id={`vis-${v}-hint`}>
                    {disabled ? t('visibility.tooFew') : t(`visibility.${v}Hint`)}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      <div class="actions">
        <button type="button" class="btn plain" onClick={() => close(false)}>
          {t('common.cancel')}
        </button>
        <button type="submit" class="btn primary">
          {t('done.save')}
        </button>
      </div>
    </form>
  );
}

export function DoneDialogHost() {
  const ref = useRef<HTMLDialogElement>(null);
  const c = current.value;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (c && !d.open) d.showModal();
    if (!c && d.open) d.close();
  }, [c]);
  const close = (done: boolean) => {
    const cur = current.value;
    current.value = null;
    cur?.resolve(done);
  };
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="done-title"
      onClose={() => current.value && close(false)}
    >
      {c && <Form key={c.item.id} item={c.item} close={close} />}
    </dialog>
  );
}
