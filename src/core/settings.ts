// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-user settings (§2, §4, §5). Stored as key/value overrides in
 * `user_settings`; defaults live here (some come from the instance config),
 * so a new default reaches everyone who never changed it.
 */
import { z } from 'zod';
import type { AppConfig } from './config';
import { isValidTimeZone, parseHM } from './time';

const hm = z.string().refine((s) => parseHM(s) !== null, 'use HH:MM (24h)');

/** Default filters for nudges and the suggest screen (§4.1 input filters). */
export const SuggestFiltersSchema = z.object({
  max_duration: z.enum(['short', 'half_day', 'day', 'weekend', 'trip']).optional(),
  setting: z.enum(['indoor', 'outdoor']).optional(),
  max_cost: z.number().int().min(0).max(3).optional(),
  energy: z.enum(['low', 'medium', 'high']).optional(),
  social: z.enum(['solo', 'together']).optional(),
  list_ids: z.array(z.string()).max(200).optional(),
  tags_include: z.array(z.string().max(50)).max(50).optional(),
  tags_exclude: z.array(z.string().max(50)).max(50).optional(),
});
export type SuggestFilters = z.infer<typeof SuggestFiltersSchema>;

export const SettingsSchema = z.object({
  locale: z.string().min(2).max(20),
  timezone: z.string().refine(isValidTimeZone, 'unknown time zone'),
  quiet_start: hm,
  quiet_end: hm,
  notify_window: z.boolean(),
  notify_shared: z.boolean(),
  notify_agent: z.boolean(),
  /** Nudges are opt-in (§5.1). */
  nudge_enabled: z.boolean(),
  nudge_count: z.number().int().min(0).max(31),
  nudge_period: z.enum(['week', 'month']),
  nudge_window_start: hm,
  nudge_window_end: hm,
  /** ISO datetime, 'forever', or null (not paused). */
  nudge_paused_until: z.union([z.iso.datetime(), z.literal('forever')]).nullable(),
  suggest_filters: SuggestFiltersSchema,
  snooze_days: z.number().int().min(1).max(365),
  require_link_approval: z.boolean(),
  agent_daily_max: z.number().int().min(0).max(1000),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingKey = keyof Settings;

export function defaultSettings(config: AppConfig): Settings {
  return {
    locale: 'en',
    timezone: 'UTC',
    quiet_start: '22:00',
    quiet_end: '08:00',
    notify_window: true,
    notify_shared: true,
    notify_agent: true,
    nudge_enabled: false,
    nudge_count: 2,
    nudge_period: 'week',
    nudge_window_start: '09:00',
    nudge_window_end: '21:00',
    nudge_paused_until: null,
    suggest_filters: {},
    snooze_days: config.SNOOZE_DAYS,
    require_link_approval: false,
    agent_daily_max: config.AGENT_NOTIFY_DAILY_MAX,
  };
}

/** Merge stored rows over the defaults; rows that no longer validate are ignored. */
export function settingsFromRows(
  config: AppConfig,
  rows: { key: string; value: string }[],
): Settings {
  const out: Record<string, unknown> = { ...defaultSettings(config) };
  const shape = SettingsSchema.shape as Record<string, z.ZodType>;
  for (const r of rows) {
    const schema = shape[r.key];
    if (!schema) continue;
    try {
      const v = schema.safeParse(JSON.parse(r.value));
      if (v.success) out[r.key] = v.data;
    } catch {
      // corrupt row: keep the default
    }
  }
  return out as Settings;
}
