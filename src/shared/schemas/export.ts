// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The export format `someday-export/v1` (§7). Versioned: a breaking change
 * means a new schema name, and import keeps accepting v1. The JSON Schema in
 * docs/someday-export-v1.schema.json describes the same shape for other tools
 * (test/export.test.ts checks that the two agree on a real export).
 */
import { z } from 'zod';
import { ItemFieldsSchema, VISIBILITIES } from './items';

export const EXPORT_SCHEMA = 'someday-export/v1';

export const ExportLogSchema = z.object({
  done_on: z.iso.date(),
  note: z.string().max(5000),
  rating: z.number().int().min(1).max(5).nullable(),
  visibility: z.enum(VISIBILITIES),
  created_at: z.string(),
});

export const ExportItemSchema = ItemFieldsSchema.omit({ list_id: true }).extend({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Only the exporting user's own entries (§7). */
  log: z.array(ExportLogSchema),
});

export const ExportListSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  role: z.enum(['owner', 'editor', 'viewer']),
  created_at: z.string(),
  /** Set for shared lists the user does not own (§7). */
  shared_from: z.object({ owner: z.string() }).nullable(),
  items: z.array(ExportItemSchema),
});

export const ExportSchema = z.object({
  schema: z.literal(EXPORT_SCHEMA),
  exported_at: z.string(),
  source: z.object({ origin: z.string(), version: z.string() }),
  user: z.object({
    display_name: z.string(),
    created_at: z.string(),
    settings: z.record(z.string(), z.unknown()),
  }),
  lists: z.array(ExportListSchema),
});

export type Export = z.infer<typeof ExportSchema>;
export type ExportList = z.infer<typeof ExportListSchema>;
export type ExportItem = z.infer<typeof ExportItemSchema>;
