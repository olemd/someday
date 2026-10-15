// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Item, list and log shapes (§3), shared by the server (validation), the
 * MCP tools and the web app (types only: `import type`, so zod stays out of
 * the PWA bundle).
 */
import { z } from 'zod';

export const STATUSES = ['idea', 'planned', 'done', 'archived'] as const;
export const DURATIONS = ['short', 'half_day', 'day', 'weekend', 'trip'] as const;
export const SETTINGS = ['indoor', 'outdoor', 'either'] as const;
export const ENERGIES = ['low', 'medium', 'high'] as const;
export const SOCIALS = ['solo', 'together', 'either'] as const;
export const VISIBILITIES = ['private', 'anonymous', 'shared'] as const;
export const ROLES = ['owner', 'editor', 'viewer'] as const;

export type Status = (typeof STATUSES)[number];
export type Duration = (typeof DURATIONS)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type Role = (typeof ROLES)[number];

const date = z.iso.date();
const httpUrl = z
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'only http(s) links');

export const LinkSchema = z.object({
  url: httpUrl,
  label: z.string().trim().max(200).optional(),
});

export const LocationSchema = z.object({
  label: z.string().trim().min(1).max(200),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

/** Tags are free-form, trimmed, lowercased, at most 50 per item. */
export const TagSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .transform((t) => t.toLowerCase());

/** Every writable item field. All context fields are optional (§3.2): null = unset. */
export const ItemFieldsSchema = z.object({
  list_id: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(20_000),
  status: z.enum(STATUSES),
  repeatable: z.boolean(),
  duration: z.enum(DURATIONS).nullable(),
  setting: z.enum(SETTINGS).nullable(),
  cost: z.number().int().min(0).max(3).nullable(),
  energy: z.enum(ENERGIES).nullable(),
  social: z.enum(SOCIALS).nullable(),
  valid_from: date.nullable(),
  valid_to: date.nullable(),
  /** Bit 0 = January … bit 11 = December; null or 0 = any month. */
  months: z.number().int().min(0).max(4095).nullable(),
  links: z.array(LinkSchema).max(50),
  location: LocationSchema.nullable(),
  tags: z.array(TagSchema).max(50),
});
export type ItemFields = z.infer<typeof ItemFieldsSchema>;
export type ItemField = keyof ItemFields;
export const ITEM_FIELDS = Object.keys(ItemFieldsSchema.shape) as ItemField[];

export const ItemCreateSchema = ItemFieldsSchema.partial()
  .required({ list_id: true, title: true })
  .extend({ id: z.string().optional() });

export const ItemPatchSchema = ItemFieldsSchema.partial();

/** What the API returns for an item, including the viewer's personal state. */
export interface Item extends Omit<ItemFields, 'tags'> {
  id: string;
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** The viewer has a log entry (§3.3 "done for me"). */
  done_for_me: boolean;
  /** The viewer's most recent done date. */
  my_last_done_on: string | null;
  snoozed_until: string | null;
  last_suggested_at: string | null;
  /** Distinct members with an anonymous or shared entry; null below the group-size threshold. */
  done_count: number | null;
  /** Names of members with a shared entry. */
  done_by: string[];
}

export const LogInputSchema = z.object({
  id: z.string().optional(),
  done_on: date,
  note: z.string().max(5000).default(''),
  rating: z.number().int().min(1).max(5).nullable().default(null),
  visibility: z.enum(VISIBILITIES).optional(),
});

export const LogPatchSchema = z.object({
  done_on: date.optional(),
  note: z.string().max(5000).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
});

export interface LogEntry {
  id: string;
  item_id: string;
  user_id: string;
  /** Author name for shared entries; null for the viewer's own entries. */
  user_name: string | null;
  done_on: string;
  note: string;
  rating: number | null;
  visibility: Visibility;
  created_at: string;
  updated_at: string;
  mine: boolean;
}

export interface Member {
  user_id: string;
  display_name: string;
  role: Role;
}

export interface List {
  id: string;
  name: string;
  role: Role;
  created_at: string;
  updated_at: string;
  member_count: number;
  members: Member[];
  include_in_suggestions: boolean;
  log_visibility: Visibility;
  anon_count_min_members: number | null;
  /** Whether the anonymous option and done-count are available (§3.3). */
  anonymous_available: boolean;
}
