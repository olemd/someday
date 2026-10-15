// SPDX-License-Identifier: AGPL-3.0-or-later
/** One list's settings: name, suggestions, Done-dialog default, delete. */
import { useState } from 'preact/hooks';
import { confirmAction } from '../components/Dialog';
import { showError, toast } from '../components/Toast';
import { del } from '../lib/api';
import { lists, ready, renameList, sync, updateMembership } from '../lib/data';
import { t } from '../lib/i18n';
import { navigate, route } from '../lib/router';

export function ListSettingsScreen() {
  const id = route.value.split('/')[2] ?? '';
  const list = lists.value.find((l) => l.id === id);
  const [name, setName] = useState(list?.name ?? '');

  if (!ready.value) return <p>{t('app.loading')}</p>;
  if (!list) {
    return (
      <div class="stack">
        <h1 tabIndex={-1}>{t('lists.notFound')}</h1>
        <a href="/lists">{t('lists.back')}</a>
      </div>
    );
  }
  const owner = list.role === 'owner';

  return (
    <div class="stack">
      <p class="small">
        <a href={`/lists/${id}`}>← {list.name}</a>
      </p>
      <h1 tabIndex={-1}>{t('listSettings.title', { name: list.name })}</h1>

      {owner && (
        <form
          class="panel stack"
          onSubmit={async (e) => {
            e.preventDefault();
            await renameList(id, name.trim());
            toast(t('common.saved'));
          }}
        >
          <div class="field">
            <label for="ls-name">{t('listSettings.name')}</label>
            <div class="inline">
              <input
                id="ls-name"
                value={name}
                maxLength={100}
                required
                onInput={(e) => setName(e.currentTarget.value)}
              />
              <button type="submit" class="btn plain">
                {t('common.save')}
              </button>
            </div>
          </div>
        </form>
      )}

      <section class="panel stack" aria-labelledby="ls-me">
        <h2 id="ls-me">{t('listSettings.forMe')}</h2>
        <label class="check">
          <input
            type="checkbox"
            checked={list.include_in_suggestions}
            onChange={(e) =>
              updateMembership(id, { include_in_suggestions: e.currentTarget.checked })
            }
          />
          {t('listSettings.includeInSuggestions')}
        </label>
      </section>

      {owner && (
        <section class="panel stack" aria-labelledby="ls-danger">
          <h2 id="ls-danger">{t('listSettings.delete')}</h2>
          <p class="hint">{t('listSettings.deleteHint')}</p>
          <div>
            <button
              type="button"
              class="btn danger-plain"
              onClick={async () => {
                if (
                  !(await confirmAction(
                    t('listSettings.deleteConfirm', { name: list.name }),
                    t('common.delete'),
                    true,
                  ))
                )
                  return;
                try {
                  await del(`/lists/${id}`);
                  await sync();
                  navigate('/lists', true);
                } catch (err) {
                  showError(err);
                }
              }}
            >
              {t('listSettings.deleteButton')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
