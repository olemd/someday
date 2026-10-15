// SPDX-License-Identifier: AGPL-3.0-or-later
/** The JSON Schema for `someday-export/v1`, derived from the zod schema (one source of truth). */
import { z } from 'zod';
import { EXPORT_SCHEMA, ExportSchema } from './export';

export function exportJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(ExportSchema, { io: 'input', unrepresentable: 'any' }),
    $id: 'https://github.com/olemd/someday/blob/main/docs/someday-export-v1.schema.json',
    title: EXPORT_SCHEMA,
    description: 'Someday data export, version 1 (SPEC §7).',
  };
}
