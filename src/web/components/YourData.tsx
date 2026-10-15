// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Your data (§7): download everything, import an export (dry run first),
 * delete the account (fresh passkey; each owned shared list is deleted or
 * handed over).
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, get, post } from '../lib/api';
import { clearLocalData, lists, sync } from '../lib/data';
import { t } from '../lib/i18n';
import { confirmAction } from './Dialog';
import { withReauth } from './Security';
import { showError, toast } from './Toast';

interface Summary {
  lists: number;
  items: number;
  log_entries: number;
  tags: number;
}

async function upload(file: File, query: string): Promise<Summary> {
  const res = await fetch(`/api/import?${query}`, {
    method: 'POST',
    body: file,
    headers: { 'content-type': file.type || 'application/octet-stream' },
    credentials: 'same-origin',
  });
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body);
  return body as Summary;
}

function Import() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'new' | 'merge'>('new');
  const [target, setTarget] = useState(lists.value.find((l) => l.role !== 'viewer')?.id ?? '');
  const [preview, setPreview] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const query = (dry: boolean) =>
    new URLSearchParams({
      mode,
      dry_run: String(dry),
      ...(mode === 'merge' ? { list_id: target } : {}),
    }).toString();

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setBusy(true);
        try {
          setPreview(await upload(file, query(true)));
        } catch (err) {
          showError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{t('data.import')}</h3>
      <p class="hint">{t('data.importIntro')}</p>
      <div class="field">
        <label for="imp-file">{t('data.file')}</label>
        <input
          id="imp-file"
          type="file"
          accept=".zip,.json,application/zip,application/json"
          onChange={(e) => {
            setFile(e.currentTarget.files?.[0] ?? null);
            setPreview(null);
          }}
        />
      </div>
      <fieldset class="field">
        <legend>{t('data.into')}</legend>
        <label class="radio">
          <input
            type="radio"
            name="imp-mode"
            checked={mode === 'new'}
            onChange={() => setMode('new')}
          />
          {t('data.intoNew')}
        </label>
        <label class="radio">
          <input
            type="radio"
            name="imp-mode"
            checked={mode === 'merge'}
            onChange={() => setMode('merge')}
          />
          {t('data.intoExisting')}
        </label>
        {mode === 'merge' && (
          <select
            aria-label={t('data.targetList')}
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
          >
            {lists.value
              .filter((l) => l.role !== 'viewer')
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        )}
      </fieldset>
      <div>
        <button type="submit" class="btn plain" disabled={!file || busy}>
          {t('data.check')}
        </button>
      </div>
      {preview && (
        <div class="notice stack tight" role="status">
          <p>
            {t('data.preview', {
              lists: preview.lists,
              items: preview.items,
              log: preview.log_entries,
            })}
          </p>
          <div>
            <button
              type="button"
              class="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await upload(file!, query(false));
                  await sync();
                  toast(t('data.imported', { count: r.items }));
                  setPreview(null);
                } catch (err) {
                  showError(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('data.importNow')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

interface SharedOwned {
  id: string;
  name: string;
  members: { user_id: string; display_name: string }[];
}

function DeleteAccount() {
  const [info, setInfo] = useState<{ shared_lists: SharedOwned[]; grace_days: number } | null>(
    null,
  );
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) get<typeof info>('/account/deletion').then(setInfo, showError);
  }, [open]);

  if (!open) {
    return (
      <div class="stack">
        <h3>{t('data.deleteAccount')}</h3>
        <div>
          <button type="button" class="btn danger-plain" onClick={() => setOpen(true)}>
            {t('data.deleteAccountStart')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="stack">
      <h3>{t('data.deleteAccount')}</h3>
      {info && <p>{t('data.deleteIntro', { days: info.grace_days })}</p>}
      {info?.shared_lists.map((l) => (
        <div class="field" key={l.id}>
          <label for={`del-${l.id}`}>{t('data.sharedListChoice', { name: l.name })}</label>
          <select
            id={`del-${l.id}`}
            value={choices[l.id] ?? ''}
            onChange={(e) => setChoices({ ...choices, [l.id]: e.currentTarget.value })}
          >
            <option value="">{t('data.choose')}</option>
            <option value="delete">{t('data.deleteForEveryone')}</option>
            {l.members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {t('data.giveTo', { name: m.display_name })}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div class="actions start">
        <button type="button" class="btn plain" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          class="btn danger"
          disabled={!info || info.shared_lists.some((l) => !choices[l.id])}
          onClick={async () => {
            if (!(await confirmAction(t('data.deleteConfirm'), t('data.deleteAccount'), true)))
              return;
            const decisions = Object.fromEntries(
              Object.entries(choices).map(([id, v]) => [
                id,
                v === 'delete' ? 'delete' : { transfer_to: v },
              ]),
            );
            try {
              await withReauth(() => post('/account/delete', { lists: decisions }));
              await clearLocalData();
              location.assign('/');
            } catch (err) {
              showError(err);
            }
          }}
        >
          {t('data.deleteAccount')}
        </button>
      </div>
    </div>
  );
}

export function YourData() {
  return (
    <section class="panel stack" id="data" aria-labelledby="data-title">
      <h2 id="data-title">{t('data.title')}</h2>
      <div class="stack">
        <h3>{t('data.download')}</h3>
        <p class="hint">{t('data.downloadIntro')}</p>
        <div>
          <a class="btn plain" href="/api/export" download>
            {t('data.downloadButton')}
          </a>
        </div>
      </div>
      <Import />
      <DeleteAccount />
    </section>
  );
}
