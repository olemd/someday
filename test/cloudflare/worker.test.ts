// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloudflare-only: the real Worker entry point with Workers Static Assets.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker entry point', () => {
  it('serves the API and /healthz', async () => {
    expect((await SELF.fetch('https://someday.test/api/health')).status).toBe(200);
    expect(await (await SELF.fetch('https://someday.test/healthz')).text()).toBe('ok');
  });

  it('returns 404 (not the SPA page) for missing hashed assets', async () => {
    const res = await SELF.fetch('https://someday.test/assets/missing-0123.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves static assets for app paths', async () => {
    const res = await SELF.fetch('https://someday.test/lists/abc');
    expect(await res.text()).toContain('fixture');
  });
});
