// SPDX-License-Identifier: AGPL-3.0-or-later
/** Configuration every test platform uses, so both run the suite under identical settings. */
export const TEST_ENV = {
  PUBLIC_ORIGIN: 'https://someday.test',
  TOKEN_PEPPER: 'test-pepper-test-pepper-test-pepper-0123',
  BOOTSTRAP_ADMIN_TOKEN: 'test-bootstrap-token-0123456789',
  // Low in tests: the suite creates many users.
  RECOVERY_PBKDF2_ITERATIONS: '1000',
  APP_VERSION: '9.9.9',
  GIT_SHA: 'testsha',
};

/** Mirrors `run_worker_first` in wrangler.template.jsonc. */
export const RUN_WORKER_FIRST = [
  '/api/*',
  '/assets/*',
  '/mcp',
  '/healthz',
  '/.well-known/oauth-*',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
];
