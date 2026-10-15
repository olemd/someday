// SPDX-License-Identifier: AGPL-3.0-or-later
/** The module registry. Explicit list, no dynamic loading: easier to debug. */
import { adminModule } from './admin';
import { authModule } from './auth';
import { healthModule, healthzModule } from './health';
import { invitesModule } from './invites';
import { linksModule } from './links';
import { noticesModule } from './notices';
import { pushModule } from './push';
import { settingsModule } from './settings';
import type { Module } from './types';

export const modules: Module[] = [
  healthModule,
  healthzModule,
  authModule,
  linksModule,
  invitesModule,
  noticesModule,
  settingsModule,
  pushModule,
  adminModule,
];
