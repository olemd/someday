// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regenerates docs/screenshots/*.png (`bun run screenshots`).
 *
 * Runs a throwaway self-hosted server, creates the admin with Chromium's
 * virtual passkey authenticator (the real setup flow), loads demo data
 * through the import endpoint (so ideas have a believable age), adds a
 * second person through a list invite, and photographs the main screens:
 * desktop, phone, dark mode and Norwegian.
 *
 * Needs `bun run build:web` first (the package script does it) and Chromium
 * (CHROMIUM_PATH=/usr/bin/chromium, or Playwright's own download).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { BOOTSTRAP_TOKEN, launch, passkeyContext, startServer } from './browser';

const root = join(import.meta.dir, '..');
const out = join(root, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });

const DESKTOP = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 844 };

const server = await startServer(18_766, { MCP_ALLOW_DCR: 'true' });
const O = server.origin;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const today = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const month = new Date().getUTCMonth(); // 0-11
const bit = (m: number) => 1 << (((m % 12) + 12) % 12);

/** A season that is on now and ends this month, so the reason reads "Season ends in …". */
const endingSeason = bit(month - 2) | bit(month - 1) | bit(month);

const item = (o: Record<string, unknown>) => ({
  notes: '',
  status: 'idea',
  repeatable: false,
  duration: null,
  setting: null,
  cost: null,
  energy: null,
  social: null,
  valid_from: null,
  valid_to: null,
  months: null,
  links: [],
  location: null,
  tags: [],
  created_at: ago(30),
  updated_at: ago(1),
  log: [],
  ...o,
});

const someday = [
  item({
    id: 'a1',
    title: 'See the northern lights from a dark beach',
    notes:
      'Check the **aurora forecast** and the cloud cover the same afternoon.\n\nBring a thermos and a tripod.',
    duration: 'day',
    setting: 'outdoor',
    cost: 1,
    energy: 'medium',
    months: endingSeason,
    tags: ['nature', 'night'],
    links: [{ url: 'https://www.yr.no', label: 'Weather' }],
    location: { label: 'Ersfjordbotn' },
    created_at: ago(430),
  }),
  item({
    id: 'a2',
    title: 'Learn to bake sourdough bread',
    setting: 'indoor',
    cost: 0,
    energy: 'low',
    duration: 'half_day',
    tags: ['food', 'learn'],
    created_at: ago(220),
    status: 'planned',
  }),
  item({
    id: 'a3',
    title: 'Swim in the sea on New Year’s Day',
    duration: 'short',
    setting: 'outdoor',
    cost: 0,
    energy: 'high',
    social: 'together',
    valid_to: today(60),
    tags: ['brave'],
    created_at: ago(90),
  }),
  item({
    id: 'a4',
    title: 'Visit the Munch museum',
    duration: 'half_day',
    setting: 'indoor',
    cost: 2,
    social: 'either',
    tags: ['art'],
    created_at: ago(400),
    status: 'done',
    log: [
      {
        done_on: today(-20),
        note: 'The Scream was smaller than I thought.',
        rating: 4,
        visibility: 'private',
        created_at: ago(20),
      },
    ],
  }),
  item({
    id: 'a5',
    title: 'Read “The Dispossessed”',
    duration: 'short',
    setting: 'indoor',
    cost: 0,
    energy: 'low',
    social: 'solo',
    tags: ['books'],
    created_at: ago(15),
  }),
  item({
    id: 'a6',
    title: 'Hike Besseggen',
    duration: 'day',
    setting: 'outdoor',
    energy: 'high',
    months: bit(5) | bit(6) | bit(7) | bit(8),
    tags: ['nature'],
    created_at: ago(700),
  }),
];

const learn = [
  item({
    id: 'b1',
    title: 'How do tides actually work?',
    duration: 'short',
    setting: 'indoor',
    cost: 0,
    energy: 'low',
    tags: ['science'],
    created_at: ago(300),
  }),
  item({
    id: 'b2',
    title: 'Basic Norwegian sign language',
    duration: 'trip',
    cost: 1,
    tags: ['language', 'learn'],
    created_at: ago(120),
  }),
  item({
    id: 'b3',
    title: 'Why is the sky blue at noon and red at sunset?',
    duration: 'short',
    tags: ['science'],
    created_at: ago(40),
  }),
];

const exportOf = (lists: { name: string; items: unknown[] }[]) => ({
  schema: 'someday-export/v1',
  exported_at: new Date().toISOString(),
  source: { origin: 'https://example.org', version: 'demo' },
  user: { display_name: 'Kari', created_at: ago(800), settings: {} },
  lists: lists.map((l, i) => ({
    id: `l${i}`,
    name: l.name,
    role: 'owner',
    created_at: ago(800),
    shared_from: null,
    items: l.items,
  })),
});

async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ([p, m, b]) => {
      const r = await fetch(`/api${p}`, {
        method: m as string,
        headers: b ? { 'content-type': 'application/json' } : undefined,
        body: b ? JSON.stringify(b) : undefined,
      });
      return r.json();
    },
    [path, method, body] as const,
  );
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage });
  console.log(`  ${name}.png`);
}

async function signup(page: Page, url: string, name: string) {
  await page.goto(url);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await page.getByRole('button', { name: 'I have saved them' }).click();
}

const browser = await launch();
try {
  console.log('Setting up demo data …');
  const { context, page } = await passkeyContext(browser, { viewport: DESKTOP });
  await signup(page, `${O}/setup?token=${BOOTSTRAP_TOKEN}`, 'Kari');
  await page.getByRole('heading', { name: 'Hi, Kari' }).waitFor();
  await api(page, '/settings', 'PATCH', { timezone: 'Europe/Oslo' });
  const lists = (await api(page, '/lists')) as { id: string }[];
  const defaultList = lists[0]!.id;
  await api(
    page,
    `/import?mode=merge&list_id=${defaultList}&dry_run=false`,
    'POST',
    exportOf([{ name: 'Someday', items: someday }]),
  );
  await api(
    page,
    '/import?dry_run=false',
    'POST',
    exportOf([{ name: 'Learn about', items: learn }]),
  );
  const shared = (await api(page, '/lists', 'POST', { name: 'Things to do with Ola' })) as {
    id: string;
  };
  for (const [title, extra] of [
    ['Night train to Bodø', { duration: 'trip', cost: 2, social: 'together', tags: ['travel'] }],
    [
      'Cook a five-course dinner',
      { duration: 'half_day', setting: 'indoor', social: 'together', tags: ['food'] },
    ],
    [
      'Kayak around Hovedøya',
      {
        duration: 'half_day',
        setting: 'outdoor',
        energy: 'medium',
        months: bit(5) | bit(6) | bit(7),
      },
    ],
  ] as const) {
    await api(page, '/items', 'POST', { list_id: shared.id, title, ...extra });
  }
  const invite = (await api(page, `/lists/${shared.id}/invites`, 'POST', { role: 'editor' })) as {
    url: string;
  };
  const { context: olaCtx, page: ola } = await passkeyContext(browser, { viewport: DESKTOP });
  await ola.goto(invite.url);
  await ola.getByRole('button', { name: 'Create an account' }).click();
  await ola.getByLabel('Your name').fill('Ola');
  await ola.getByRole('button', { name: 'Create passkey' }).click();
  await ola.getByRole('button', { name: 'I have saved them' }).click();
  await ola.getByRole('heading', { name: 'Lists' }).waitFor();
  const olaItems = (await api(ola, `/items?list_id=${shared.id}`)) as {
    id: string;
    title: string;
  }[];
  const dinner = olaItems.find((i) => i.title.startsWith('Cook'))!;
  await api(ola, `/items/${dinner.id}/log`, 'POST', {
    done_on: today(-3),
    note: 'Mushroom risotto was the star.',
    rating: 5,
    visibility: 'shared',
  });
  await olaCtx.close();

  console.log('Screenshots:');
  // 1. Give me something: re-roll until the northern lights come up.
  await page.goto(`${O}/`);
  await page.reload();
  await page.getByRole('heading', { name: 'Hi, Kari' }).waitFor();
  for (let i = 0; i < 30; i++) {
    await page
      .getByRole('button', { name: /Give me something to do|Another one/ })
      .first()
      .click();
    await page.locator('.suggestion').waitFor();
    if ((await page.locator('#suggestion-title').textContent())?.includes('northern lights')) break;
  }
  await shot(page, '01-give-me-something');

  // 2. A list.
  await page.goto(`${O}/lists`);
  await shot(page, '02-lists');
  await page.locator('.list-card', { hasText: 'Someday' }).first().click();
  await page.getByText('Learn to bake sourdough bread').waitFor();
  await shot(page, '03-list');

  // 3. An idea with its log.
  await page.goto(`${O}/lists/${defaultList}?show=all`);
  await page.getByText('Visit the Munch museum').click();
  await page.getByRole('heading', { name: 'Visit the Munch museum' }).waitFor();
  await shot(page, '04-idea');

  // 4. Done on a shared list: who may see it.
  await page.goto(`${O}/lists/${shared.id}`);
  await page.getByText('Night train to Bodø').click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('#done-note').fill('Slept surprisingly well.');
  await shot(page, '05-done-dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // 5. Sharing: members and an invite link with QR code.
  await page.goto(`${O}/lists/${shared.id}/settings`);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await page.locator('.qr').waitFor();
  await shot(page, '06-sharing', true);

  // 6. Adding another device: link, QR and short code.
  await page.goto(`${O}/settings/security`);
  await page.getByRole('button', { name: 'Create a link' }).click();
  await page.locator('.code-big').waitFor();
  await page.locator('#security').scrollIntoViewIfNeeded();
  await shot(page, '07-add-device');

  // 7. Notifications and nudges.
  await api(page, '/settings', 'PATCH', { nudge_enabled: true, nudge_count: 3 });
  await page.goto(`${O}/settings/notifications`);
  await page.locator('#nudges').scrollIntoViewIfNeeded();
  await shot(page, '08-nudges');

  // 8. Connecting an assistant (MCP consent).
  const reg = (await (
    await fetch(`${O}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'My Assistant',
        redirect_uris: ['https://assistant.example/callback'],
      }),
    })
  ).json()) as { client_id: string };
  await page.goto(
    `${O}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: 'https://assistant.example/callback',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      scope: 'someday:read someday:write someday:notify',
      state: 'x',
    })}`,
  );
  await page.getByRole('button', { name: 'Allow' }).waitFor();
  await shot(page, '09-connect-assistant');

  // 9. Phone, dark mode and Norwegian.
  const phone = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-GB',
    timezoneId: 'Europe/Oslo',
  });
  await phone.addCookies(await context.cookies());
  const p = await phone.newPage();
  await p.goto(`${O}/`);
  await p.getByRole('button', { name: 'Give me something to do' }).click();
  await p.locator('.suggestion').waitFor();
  await shot(p, '10-phone');
  await p.goto(`${O}/lists/${defaultList}`);
  await p.getByText('Learn to bake sourdough bread').waitFor();
  await p.emulateMedia({ colorScheme: 'dark' });
  await shot(p, '11-phone-dark');
  await api(p, '/settings', 'PATCH', { locale: 'nb' });
  await p.emulateMedia({ colorScheme: 'light' });
  await p.goto(`${O}/`);
  await p.getByRole('button', { name: 'Gi meg noe å gjøre' }).click();
  await p.locator('.suggestion').waitFor();
  await shot(p, '12-phone-norwegian');
  await api(p, '/settings', 'PATCH', { locale: 'en' });
  await phone.close();
  console.log(`Saved in ${out}`);
} finally {
  await browser.close();
  server.stop();
}
