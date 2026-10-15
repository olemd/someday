// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One list's settings (§3.1, §3.3): name, sharing (members, roles, invite
 * links, ownership), the anonymity threshold, personal preferences, leave
 * or delete.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Visibility } from '../../shared/schemas/items';
import { confirmAction } from '../components/Dialog';
import { Qr } from '../components/Qr';
import { showError, toast } from '../components/Toast';
import { del, get, patch, post } from '../lib/api';
import { lists, ready, renameList, sync, updateMembership } from '../lib/data';
import { calendarDate } from '../lib/fmt';
import { t } from '../lib/i18n';
import { navigate, route } from '../lib/router';
import { auth } from '../lib/store';

interface Invite {
  id: string;
  role: 'editor' | 'viewer';
  created_at: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked: boolean;
}

/** Run an online-only change, then pull it into the local mirror. */
async function online(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    await sync();
    if (done) toast(done);
  } catch (err) {
    showError(err);
  }
}

function Invites({ listId }: { listId: string }) {
  const [list, setList] = useState<Invite[]>([]);
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [uses, setUses] = useState(1);
  const [fresh, setFresh] = useState<{ url: string } | null>(null);
  const load = () => get<Invite[]>(`/lists/${listId}/invites`).then(setList, showError);
  useEffect(() => void load(), [listId]);
  const active = list.filter(
    (i) => !i.revoked && i.uses < i.max_uses && Date.parse(i.expires_at) > Date.now(),
  );

  return (
    <div class="stack">
      <h3>{t('share.inviteTitle')}</h3>
      <p class="hint">{t('share.inviteIntro')}</p>
      <div class="grid-2">
        <div class="field">
          <label for="inv-role">{t('share.role')}</label>
          <select
            id="inv-role"
            value={role}
            onChange={(e) => setRole(e.currentTarget.value as 'editor')}
          >
            <option value="editor">{t('role.editor')}</option>
            <option value="viewer">{t('role.viewer')}</option>
          </select>
        </div>
        <div class="field">
          <label for="inv-uses">{t('share.uses')}</label>
          <input
            id="inv-uses"
            type="number"
            min={1}
            max={100}
            value={uses}
            onInput={(e) => setUses(Math.max(1, Math.min(100, Number(e.currentTarget.value) || 1)))}
          />
        </div>
      </div>
      <div>
        <button
          type="button"
          class="btn plain"
          onClick={async () => {
            try {
              setFresh(
                await post<{ url: string }>(`/lists/${listId}/invites`, { role, max_uses: uses }),
              );
              void load();
            } catch (err) {
              showError(err);
            }
          }}
        >
          {t('share.createLink')}
        </button>
      </div>
      {fresh && (
        <div class="panel stack">
          <Qr value={fresh.url} label={t('share.qrLabel')} />
          <p class="row">
            <code class="small break">{fresh.url}</code>
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh.url);
                toast(t('link.copied'));
              }}
            >
              {t('common.copy')}
            </button>
          </p>
        </div>
      )}
      {active.length > 0 && (
        <ul class="plain stack tight">
          {active.map((i) => (
            <li key={i.id} class="row">
              <span class="small">
                {t('share.inviteRow', {
                  role: t(`role.${i.role}`),
                  used: i.uses,
                  max: i.max_uses,
                  date: calendarDate(i.expires_at.slice(0, 10)),
                })}
              </span>
              <button
                type="button"
                class="btn plain small"
                onClick={async () => {
                  await del(`/lists/${listId}/invites/${i.id}`).catch(showError);
                  void load();
                }}
              >
                {t('share.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ListSettingsScreen() {
  const id = route.value.split('/')[2] ?? '';
  const list = lists.value.find((l) => l.id === id);
  const [name, setName] = useState(list?.name ?? '');
  const [threshold, setThreshold] = useState(String(list?.anon_count_min_members ?? ''));
  // The list may arrive after the first render (opened directly, data still loading).
  useEffect(() => {
    if (!list) return;
    setName(list.name);
    setThreshold(String(list.anon_count_min_members ?? ''));
  }, [list?.id, list?.name, list?.anon_count_min_members]);
  const me = auth.value?.user?.id;

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
  const shared = list.member_count > 1;

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

      <section class="panel stack" aria-labelledby="ls-members">
        <h2 id="ls-members">{t('share.members')}</h2>
        <ul class="plain stack tight">
          {list.members.map((m) => (
            <li key={m.user_id} class="row">
              <span>
                {m.display_name}
                {m.user_id === me && <> ({t('share.you')})</>}
              </span>
              {owner && m.role !== 'owner' ? (
                <span class="actions">
                  <label class="visually-hidden" for={`role-${m.user_id}`}>
                    {t('share.roleOf', { name: m.display_name })}
                  </label>
                  <select
                    id={`role-${m.user_id}`}
                    value={m.role}
                    onChange={(e) =>
                      online(
                        () =>
                          patch(`/lists/${id}/members/${m.user_id}`, {
                            role: e.currentTarget.value,
                          }),
                        t('common.saved'),
                      )
                    }
                  >
                    <option value="editor">{t('role.editor')}</option>
                    <option value="viewer">{t('role.viewer')}</option>
                  </select>
                  <button
                    type="button"
                    class="btn plain small"
                    onClick={async () => {
                      if (
                        await confirmAction(
                          t('share.transferConfirm', { name: m.display_name }),
                          t('share.transfer'),
                        )
                      )
                        await online(
                          () => post(`/lists/${id}/transfer`, { user_id: m.user_id }),
                          t('share.transferred'),
                        );
                    }}
                  >
                    {t('share.transfer')}
                  </button>
                  <button
                    type="button"
                    class="btn danger-plain small"
                    onClick={async () => {
                      if (
                        await confirmAction(
                          t('share.removeConfirm', { name: m.display_name }),
                          t('common.remove'),
                          true,
                        )
                      )
                        await online(() => del(`/lists/${id}/members/${m.user_id}`));
                    }}
                  >
                    {t('common.remove')}
                  </button>
                </span>
              ) : (
                <span class="muted small">{t(`role.${m.role}`)}</span>
              )}
            </li>
          ))}
        </ul>
        {owner && <Invites listId={id} />}
        {owner && shared && (
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void online(
                () =>
                  patch(`/lists/${id}`, {
                    anon_count_min_members: threshold ? Number(threshold) : null,
                  }),
                t('common.saved'),
              );
            }}
          >
            <div class="field">
              <label for="ls-anon">{t('share.threshold')}</label>
              <div class="inline">
                <input
                  id="ls-anon"
                  type="number"
                  min={3}
                  max={1000}
                  placeholder={t('share.thresholdDefault')}
                  value={threshold}
                  onInput={(e) => setThreshold(e.currentTarget.value)}
                />
                <button type="submit" class="btn plain">
                  {t('common.save')}
                </button>
              </div>
              <span class="hint">{t('share.thresholdHint')}</span>
            </div>
          </form>
        )}
      </section>

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
        {shared && (
          <div class="field">
            <label for="ls-vis">{t('listSettings.defaultVisibility')}</label>
            <select
              id="ls-vis"
              value={list.log_visibility}
              onChange={(e) =>
                updateMembership(id, { log_visibility: e.currentTarget.value as Visibility })
              }
            >
              <option value="private">{t('visibility.private')}</option>
              <option value="anonymous" disabled={!list.anonymous_available}>
                {t('visibility.anonymous')}
              </option>
              <option value="shared">{t('visibility.shared')}</option>
            </select>
          </div>
        )}
        {!owner && (
          <div>
            <button
              type="button"
              class="btn danger-plain"
              onClick={async () => {
                if (
                  !(await confirmAction(
                    t('share.leaveConfirm', { name: list.name }),
                    t('share.leave'),
                    true,
                  ))
                )
                  return;
                await online(() => del(`/lists/${id}/members/${me}`));
                navigate('/lists', true);
              }}
            >
              {t('share.leave')}
            </button>
          </div>
        )}
      </section>

      {owner && (
        <section class="panel stack" aria-labelledby="ls-danger">
          <h2 id="ls-danger">{t('listSettings.delete')}</h2>
          <p class="hint">{t('listSettings.deleteHint')}</p>
          {shared && <p class="hint">{t('share.deleteShared')}</p>}
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
                await online(() => del(`/lists/${id}`));
                navigate('/lists', true);
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
