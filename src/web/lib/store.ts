// SPDX-License-Identifier: AGPL-3.0-or-later
/** Session-level app state as signals: who is logged in, their settings and notices. */
import { signal } from '@preact/signals';
import { get } from './api';

export interface AuthStatus {
  authenticated: boolean;
  must_register: boolean;
  user: {
    id: string;
    display_name: string;
    role: 'admin' | 'user';
    passkey_id: string | null;
  } | null;
  registration_mode: 'invite' | 'open' | 'closed';
  setup_available: boolean;
  push_public_key: string | null;
}

export interface SuggestFilters {
  max_duration?: Duration;
  setting?: 'indoor' | 'outdoor';
  max_cost?: number;
  energy?: Energy;
  social?: 'solo' | 'together';
  list_ids?: string[];
  tags_include?: string[];
  tags_exclude?: string[];
}
export type Duration = 'short' | 'half_day' | 'day' | 'weekend' | 'trip';
export type Energy = 'low' | 'medium' | 'high';

export interface Settings {
  locale: string;
  timezone: string;
  quiet_start: string;
  quiet_end: string;
  notify_window: boolean;
  notify_shared: boolean;
  notify_agent: boolean;
  nudge_enabled: boolean;
  nudge_count: number;
  nudge_period: 'week' | 'month';
  nudge_window_start: string;
  nudge_window_end: string;
  nudge_paused_until: string | null;
  suggest_filters: SuggestFilters;
  snooze_days: number;
  require_link_approval: boolean;
  agent_daily_max: number;
}

export interface Notice {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  created_at: string;
}

export const auth = signal<AuthStatus | null>(null);
export const settings = signal<Settings | null>(null);
export const notices = signal<Notice[]>([]);
export const online = signal(navigator.onLine);

addEventListener('online', () => (online.value = true));
addEventListener('offline', () => (online.value = false));

export async function loadAuth() {
  auth.value = await get<AuthStatus>('/auth/status');
}

export async function loadSettings() {
  settings.value = await get<Settings>('/settings');
}

export async function loadNotices() {
  notices.value = await get<Notice[]>('/notices');
}
