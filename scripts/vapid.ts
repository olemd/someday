// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generates VAPID keys for Web Push (§8.4) and prints them. Set them with:
 *   bunx wrangler secret put VAPID_PUBLIC_KEY   (etc.)
 * `bun run bootstrap` does this for you on first setup.
 */
import { generateVapidKeys } from './lib';

const { publicKey, privateKey } = await generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com   # your contact address');
