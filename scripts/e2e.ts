// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End-to-end smoke test of the PWA against the self-hosted server, in a real
 * Chromium with a virtual WebAuthn authenticator (passkeys work on
 * http://localhost). Needs `bun run build:web` first and Playwright's
 * Chromium (`node node_modules/playwright/cli.js install chromium`).
 *
 *   bun scripts/e2e.ts            # headless
 *   HEADED=1 bun scripts/e2e.ts   # watch it
 */
import { join } from 'node:path';
import type { Page } from 'playwright';
import { BOOTSTRAP_TOKEN as TOKEN, launch, passkeyContext, startServer } from './browser';

const PORT = 18_765;
// The e2e MCP client registers dynamically (no hosted metadata document).
const server = await startServer(PORT, { MCP_ALLOW_DCR: 'true' });
const ORIGIN = server.origin;
const dir = server.dir;
// KEEP_DB=1: leave the database for inspection.
const cleanup = () => server.stop(!!process.env.KEEP_DB);

let failed = false;
/** SCREENSHOTS=<dir>: save a screenshot after each step (light and narrow, for review). */
const shots = process.env.SCREENSHOTS;
let shotNo = 0;
let shotPage: Page | null = null;
const errors: string[] = [];
const step = async (name: string, fn: () => Promise<void>) => {
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
    if (shots && shotPage) {
      await shotPage.screenshot({
        path: join(shots, `${String(++shotNo).padStart(2, '0')}-${name.replace(/\W+/g, '-')}.png`),
        fullPage: true,
      });
    }
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    if (shotPage) await shotPage.screenshot({ path: join(dir, 'failure.png'), fullPage: true });
    if (errors.length) console.error(`Console errors so far:\n- ${errors.join('\n- ')}`);
    throw err;
  }
};

try {
  const browser = await launch();
  const { context, page } = await passkeyContext(browser);
  shotPage = page;
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));

  await step('setup creates the first admin with a passkey', async () => {
    await page.goto(`${ORIGIN}/setup?token=${TOKEN}`);
    await page.getByLabel('Your name').fill('Kari');
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await page.getByRole('heading', { name: 'Hi, Kari' }).waitFor();
  });

  await step('adds ideas to the default list', async () => {
    await page.getByRole('link', { name: 'Lists' }).first().click();
    await page.locator('.list-card', { hasText: 'Someday' }).click();
    await page.getByLabel('New idea').fill('See the northern lights');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('See the northern lights').waitFor();
    await page.getByRole('link', { name: 'With details' }).click();
    await page.getByLabel('What').fill('Learn to make sourdough');
    await page.getByLabel('Where').selectOption('indoor');
    await page.getByLabel('Tags').fill('food, learn');
    await page.getByRole('button', { name: 'Add idea' }).click();
    await page.getByRole('heading', { name: 'Learn to make sourdough' }).waitFor();
  });

  await step('suggests something with reasons', async () => {
    await page.getByRole('link', { name: 'Something' }).first().click();
    await page.getByRole('button', { name: 'Give me something to do' }).click();
    await page.locator('.suggestion .reasons li').first().waitFor();
    const reasons = await page.locator('.suggestion .reasons li').allTextContents();
    if (!reasons.length) throw new Error('no reasons shown');
  });

  await step('logs a suggestion as done', async () => {
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Note').fill('Lovely');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByText(/^Logged:/).waitFor();
  });

  await step('works offline and syncs when back online', async () => {
    await page.getByRole('link', { name: 'Lists' }).first().click();
    await page.locator('.list-card', { hasText: 'Someday' }).click();
    await context.setOffline(true);
    await page.getByLabel('New idea').fill('Offline idea');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Offline idea').waitFor();
    await page.getByText(/change waiting to be sent/).waitFor();
    await context.setOffline(false);
    await page.evaluate('dispatchEvent(new Event("online"))');
    await page.getByText(/change waiting to be sent/).waitFor({ state: 'detached' });
    await page.reload();
    await page.getByText('Offline idea').waitFor();
  });

  await step('shares a list: a new person signs up through the invite and joins', async () => {
    await page.getByRole('link', { name: 'Lists' }).first().click();
    await page.locator('.list-card', { hasText: 'Someday' }).click();
    await page.getByRole('link', { name: 'List settings' }).click();
    await page.getByRole('button', { name: 'Create invite link' }).click();
    const url = (await page.locator('code.break').textContent())!.trim();

    const { context: bobCtx, page: bob } = await passkeyContext(browser);
    bob.on('pageerror', (e) => errors.push(`bob: ${e}`));
    await bob.goto(url);
    await bob.getByRole('heading', { name: 'Join “Someday”' }).waitFor();
    await bob.getByRole('button', { name: 'Create an account' }).click();
    await bob.getByLabel('Your name').fill('Bob');
    await bob.getByRole('button', { name: 'Create passkey' }).click();
    await bob.getByRole('button', { name: 'I have saved them' }).click();
    await bob.getByRole('heading', { name: 'Lists' }).waitFor();
    await bob.locator('.list-card', { hasText: '2 members' }).click();
    await bob.getByText('Offline idea').waitFor();
    await bob.getByLabel('New idea').fill('Idea from Bob');
    await bob.getByRole('button', { name: 'Add', exact: true }).click();
    await bob.getByText('Idea from Bob').waitFor();
    // The outbox is pushed after a short debounce: wait until it has gone out.
    await bob.locator('.banner[role="status"]').waitFor({ state: 'detached' });
    await bob.waitForLoadState('networkidle');
    const problems = await bob.locator('.sync-problem').allTextContents();
    if (problems.length) throw new Error(`sync problems for Bob: ${problems.join('; ')}`);

    await page.reload();
    await page.getByText('Bob', { exact: true }).waitFor();
    await page.goto(`${ORIGIN}/lists`);
    await page.locator('.list-card', { hasText: 'Someday' }).click();
    await page.getByText('Idea from Bob').waitFor();
    await bobCtx.close();
  });

  await step('downloads the data export', async () => {
    await page.getByRole('link', { name: 'Settings' }).first().click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Download zip' }).click(),
    ]);
    if (!download.suggestedFilename().startsWith('someday-export-')) {
      throw new Error(`unexpected file name ${download.suggestedFilename()}`);
    }
    const bytes = await Bun.file((await download.path())!).bytes();
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('not a zip');
  });

  await step('connects an MCP client through OAuth consent and calls a tool', async () => {
    const callback = 'http://127.0.0.1:47123/callback';
    const reg = (await (
      await fetch(`${ORIGIN}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'E2E Assistant', redirect_uris: [callback] }),
      })
    ).json()) as { client_id: string };
    const verifier = 'v'.repeat(64);
    const challenge = Buffer.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    ).toString('base64url');
    const authUrl = `${ORIGIN}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: callback,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'someday:read someday:write',
      state: 's1',
      resource: `${ORIGIN}/mcp`,
    })}`;
    let redirected = '';
    await page.route('http://127.0.0.1:47123/**', (route) => {
      redirected = route.request().url();
      return route.fulfill({ status: 200, body: 'ok' });
    });
    await page.goto(authUrl);
    await page.getByRole('heading', { name: 'Let E2E Assistant use Someday?' }).waitFor();
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(/127\.0\.0\.1:47123/);
    const code = new URL(redirected).searchParams.get('code')!;
    const tok = (await (
      await fetch(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: callback,
          client_id: reg.client_id,
          code_verifier: verifier,
          resource: `${ORIGIN}/mcp`,
        }),
      })
    ).json()) as { access_token: string };
    const res = await fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'create_item',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_item',
          arguments: { title: 'Added by the assistant' },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const rpc = (await res.json()) as { result?: { isError?: boolean } };
    if (rpc.result?.isError || !rpc.result)
      throw new Error(`tool call failed: ${JSON.stringify(rpc)}`);
    await page.goto(`${ORIGIN}/settings`);
    await page.getByText('E2E Assistant').waitFor();
    await page.goto(`${ORIGIN}/lists`);
    await page.locator('.list-card', { hasText: 'Someday' }).click();
    await page.getByText('Added by the assistant').click();
    await page.getByText('History').click();
    await page.getByText('via E2E Assistant').waitFor();
  });

  await step('logs in again with the passkey', async () => {
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByRole('button', { name: 'Log in with passkey' }).click();
    await page.getByRole('heading', { name: 'Hi, Kari' }).waitFor();
  });

  if (errors.length) {
    failed = true;
    console.error(`Console errors:\n- ${errors.join('\n- ')}`);
  }
  await browser.close();
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  cleanup();
}
if (failed) process.exit(1);
console.log('e2e OK');
