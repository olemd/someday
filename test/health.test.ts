// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config';
import { harness } from './helpers';

describe('GET /api/health', () => {
  it('reports version, sha and no config errors', async () => {
    const { status, body } = await harness().json('/api/health');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', version: '9.9.9', git_sha: 'testsha', config_errors: [] });
  });

  it('sets security headers and no-store', async () => {
    const res = await harness().fetch('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects unauthenticated API calls with 401', async () => {
    expect((await harness().json('/api/nope')).status).toBe(401);
  });
});

describe('config', () => {
  it('requires PUBLIC_ORIGIN and TOKEN_PEPPER, and reports problems instead of crashing', () => {
    const { errors, config } = parseConfig({});
    expect(errors.join('\n')).toMatch(/PUBLIC_ORIGIN/);
    expect(errors.join('\n')).toMatch(/TOKEN_PEPPER/);
    expect(config.REGISTRATION_MODE).toBe('invite');
  });

  it('derives the RP ID and applies overrides', () => {
    const { config, errors } = parseConfig({
      PUBLIC_ORIGIN: 'https://someday.silly.work',
      TOKEN_PEPPER: 'x'.repeat(32),
      REGISTRATION_MODE: 'open',
      INVITES_ADMIN_ONLY: 'true',
      ANON_COUNT_MIN_MEMBERS: '5',
    });
    expect(errors).toEqual([]);
    expect(config).toMatchObject({
      RP_ID: 'someday.silly.work',
      REGISTRATION_MODE: 'open',
      INVITES_ADMIN_ONLY: true,
      ANON_COUNT_MIN_MEMBERS: 5,
      DEVICE_LINK_TTL_MIN: 15,
    });
  });

  it('rejects plain http outside localhost and origins with a path', () => {
    const base = { TOKEN_PEPPER: 'x'.repeat(32) };
    expect(parseConfig({ ...base, PUBLIC_ORIGIN: 'http://example.com' }).errors).toHaveLength(1);
    expect(parseConfig({ ...base, PUBLIC_ORIGIN: 'http://localhost:8080' }).errors).toEqual([]);
    expect(parseConfig({ ...base, PUBLIC_ORIGIN: 'https://x.test/app' }).errors).toHaveLength(1);
  });
});
