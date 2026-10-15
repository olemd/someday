// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-app notices (§2.1): security events shown on every session until
 * dismissed, mirrored as a push. "New passkey added: Firefox on Linux, 09:22"
 * with a one-tap "That wasn't me".
 */
import { iso } from '../../core/ports';
import { settingsFromRows } from '../../core/settings';
import { formatHM, minuteOfDay } from '../../core/time';
import { ulid } from '../../core/ulid';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { createTranslator } from '../../shared/i18n/translate';
import { sendToUser } from '../push/service';
import type { Ctx } from '../types';

export async function userSettings(ctx: Ctx, userId: string) {
  return settingsFromRows(
    ctx.config,
    await ctx.db.all('SELECT key, value FROM user_settings WHERE user_id = ?', userId),
  );
}

export async function translatorFor(ctx: Ctx, userId: string) {
  const s = await userSettings(ctx, userId);
  return { ...createTranslator(s.locale, catalogs), settings: s };
}

/**
 * Record a "passkey added" notice and push it to the user's devices. Called
 * after the passkey is committed. Security notices ignore quiet hours.
 */
export async function notifyPasskeyAdded(
  ctx: Ctx,
  userId: string,
  passkeyId: string,
  label: string,
): Promise<void> {
  const now = ctx.clock.now();
  const id = ulid(now);
  await ctx.db.run(
    'INSERT INTO notices (id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    userId,
    'passkey_added',
    JSON.stringify({ passkey_id: passkeyId, label }),
    iso(now),
  );
  const { t, settings } = await translatorFor(ctx, userId);
  const time = formatHM(minuteOfDay(now, settings.timezone));
  ctx.scheduler.waitUntil(
    sendToUser(
      ctx,
      userId,
      {
        title: t('push.passkeyAddedTitle'),
        body: t('push.passkeyAddedBody', { label, time }),
        url: `/settings/security?notice=${id}`,
        tag: `notice-${id}`,
      },
      { urgency: 'high' },
    ),
  );
}
