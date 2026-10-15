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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const PORT = 18_765;
const ORIGIN = `http://localhost:${PORT}`;
const TOKEN = 'e2e-bootstrap-token-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'someday-e2e-'));

const server = Bun.spawn(['bun', 'src/platform/bun/server.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATABASE_PATH: join(dir, 'e2e.db'),
    STATIC_DIR: 'dist/web',
    PUBLIC_ORIGIN: ORIGIN,
    TOKEN_PEPPER: 'e2e-pepper-e2e-pepper-e2e-pepper-0123',
    BOOTSTRAP_ADMIN_TOKEN: TOKEN,
  },
  stdout: 'ignore',
  stderr: 'inherit',
});

const cleanup = () => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
};

let failed = false;
/** SCREENSHOTS=<dir>: save a screenshot after each step (light and narrow, for review). */
const shots = process.env.SCREENSHOTS;
let shotNo = 0;
let shotPage: Page | null = null;
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
    throw err;
  }
};

try {
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(`${ORIGIN}/healthz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await Bun.sleep(100);
  }
  // CHROMIUM_PATH: use an installed Chromium instead of Playwright's download.
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Oslo' });
  const page: Page = await context.newPage();
  shotPage = page;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // A virtual platform authenticator with user verification: real passkeys.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

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
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.getByText(/change waiting to be sent/).waitFor({ state: 'detached' });
    await page.reload();
    await page.getByText('Offline idea').waitFor();
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
