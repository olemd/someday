// SPDX-License-Identifier: AGPL-3.0-or-later
/** The module registry. Explicit list, no dynamic loading: easier to debug. */
import { adminModule } from './admin';
import { authModule } from './auth';
import { healthModule, healthzModule } from './health';
import { invitesModule } from './invites';
import { itemsModule, logModule, tagsModule } from './items';
import { linksModule } from './links';
import { joinModule, listsModule } from './lists';
import { noticesModule } from './notices';
import { mcpModule } from './mcp';
import { notifyModule } from './notify';
import { oauthApiModule, oauthModule, wellKnownModule } from './oauth';
import { pushModule } from './push';
import { settingsModule } from './settings';
import { snoozeModule, suggestModule } from './suggest';
import { syncModule } from './sync';
import { accountModule, exportModule, importModule } from './takeaway';
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
  listsModule,
  joinModule,
  itemsModule,
  logModule,
  tagsModule,
  suggestModule,
  snoozeModule,
  syncModule,
  notifyModule,
  exportModule,
  importModule,
  accountModule,
  wellKnownModule,
  oauthModule,
  oauthApiModule,
  mcpModule,
];
