// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Writes docs/someday-export-v1.schema.json (JSON Schema) from the zod schema
 * in src/shared/schemas/export.ts. test/export.test.ts fails if the committed
 * file is out of date. Run after changing the export format.
 */
import { join } from 'node:path';
import { exportJsonSchema } from '../src/shared/schemas/export-json';

const out = join(import.meta.dir, '..', 'docs', 'someday-export-v1.schema.json');
await Bun.write(out, `${JSON.stringify(exportJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
