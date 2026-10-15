// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppConfig } from '../../core/config';
import type { Clock, PushSender } from '../../core/ports';
import { createPushSender } from './webpush';

/** A push sender when the VAPID keys are configured, otherwise null (push off). */
export function pushSenderFromConfig(config: AppConfig, clock: Clock): PushSender | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = config;
  if (!publicKey || !privateKey) return null;
  const subject = config.VAPID_SUBJECT ?? config.PUBLIC_ORIGIN;
  return createPushSender({ publicKey, privateKey, subject }, () => Math.floor(clock.now() / 1000));
}
