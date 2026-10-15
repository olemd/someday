// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security notices on every other session (§2.1): "New passkey added:
 * Firefox on Linux, 09:22" with a one-tap "That wasn't me" that revokes the
 * passkey and its sessions.
 */
import { del, post } from '../lib/api';
import { time } from '../lib/fmt';
import { t } from '../lib/i18n';
import { auth, loadNotices, notices } from '../lib/store';
import { confirmAction } from './Dialog';
import { showError, toast } from './Toast';

export function NoticeBanners() {
  const mine = auth.value?.user?.passkey_id ?? null;
  const shown = notices.value.filter(
    // The device that added the passkey does not need to hear about it.
    (n) => !(n.kind === 'passkey_added' && n.data.passkey_id === mine),
  );
  const dismiss = async (id: string) => {
    await post(`/notices/${id}/dismiss`).catch(showError);
    await loadNotices().catch(() => undefined);
  };
  return (
    <>
      {shown.map((n) => (
        <div class="banner alert" role="alert" key={n.id}>
          <span>
            {t('notice.passkeyAdded', {
              label: String(n.data.label ?? ''),
              time: time(n.created_at),
            })}
          </span>
          <button
            type="button"
            class="btn danger small"
            onClick={async () => {
              if (!(await confirmAction(t('notice.notMeConfirm'), t('notice.notMe'), true))) return;
              try {
                await del(`/auth/passkeys/${encodeURIComponent(String(n.data.passkey_id))}`);
                toast(t('notice.revoked'));
              } catch (err) {
                showError(err);
              }
              await dismiss(n.id);
            }}
          >
            {t('notice.notMe')}
          </button>
          <button type="button" class="btn plain small" onClick={() => dismiss(n.id)}>
            {t('notice.itWasMe')}
          </button>
        </div>
      ))}
    </>
  );
}
