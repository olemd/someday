// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-time interactive setup of Someday on your own Cloudflare account, and
 * of the GitHub repository that deploys it (`bun run bootstrap`):
 *
 *   1. picks the Cloudflare account, creates (or reuses) the D1 database,
 *   2. builds, applies migrations and deploys the Worker; without a custom
 *      domain the *.workers.dev address becomes PUBLIC_ORIGIN,
 *   3. sets the Worker secrets: TOKEN_PEPPER, BOOTSTRAP_ADMIN_TOKEN and VAPID
 *      keys (existing ones are kept: rotating the pepper would log everyone
 *      out, new VAPID keys would break every push subscription),
 *   4. optionally the same for a `preview` environment (PR label `preview`),
 *   5. with `gh`: sets the GitHub Variables and the CLOUDFLARE_ACCOUNT_ID and
 *      CLOUDFLARE_API_TOKEN secrets CI needs (the API token is created by you
 *      in the Cloudflare dashboard from a prefilled link, then pasted here,
 *      verified, and piped to `gh` — never written to disk or argv),
 *   6. checks /api/health and prints the /setup link for the first admin.
 *
 * Safe to run again: it reuses the database, keeps secrets, updates variables.
 * Prerequisites: `bunx wrangler login`; for step 5 `gh auth login`.
 * Non-secret values are saved to .env (git-ignored) for `bun run render-config`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ask, askHidden, confirm, exec, generateVapidKeys, randomSecret, wrangler } from './lib';

const root = join(import.meta.dir, '..');
const CF_API = 'https://api.cloudflare.com/client/v4';

const step = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);
const run = (cmd: string[]) => exec(cmd, { echo: true });

/** Read KEY=VALUE pairs from .env (Bun also loads it into process.env). */
function readEnvFile(): Record<string, string> {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function writeEnvFile(values: Record<string, string>) {
  const lines = [
    '# Written by `bun run bootstrap`; read by `bun run render-config`. Not committed.',
    ...Object.entries(values)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(join(root, '.env'), `${lines.join('\n')}\n`);
  Object.assign(process.env, values);
}

const workersDevUrl = (out: string) => /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(out)?.[0];

async function findOrCreateD1(name: string): Promise<string> {
  type D1 = { uuid: string; name: string };
  const list = async () => JSON.parse(await wrangler(['d1', 'list', '--json'])) as D1[];
  let db = (await list()).find((d) => d.name === name);
  if (db) {
    console.log(`Using the existing D1 database "${name}".`);
  } else {
    await wrangler(['d1', 'create', name], { echo: true });
    db = (await list()).find((d) => d.name === name);
  }
  if (!db) throw new Error(`Could not find the D1 database "${name}" after creating it`);
  return db.uuid;
}

async function existingSecrets(env?: string): Promise<Set<string>> {
  // Runs after the deploy, so the Worker exists and listing must work. If it
  // does not, stop: guessing "no secrets yet" would generate a new
  // TOKEN_PEPPER (logging everyone out) and new VAPID keys (breaking push).
  const r = await exec(
    ['bunx', 'wrangler', 'secret', 'list', '--format', 'json', '--env', env ?? ''],
    { allowFail: true },
  );
  let names: { name: string }[] | null = null;
  try {
    names = r.ok ? (JSON.parse(r.out) as { name: string }[]) : null;
  } catch {
    names = null;
  }
  if (!Array.isArray(names)) {
    throw new Error(
      'Could not list the existing Worker secrets, so none were changed. Fix the problem above and run bootstrap again.',
    );
  }
  return new Set(names.map((s) => s.name));
}

/**
 * Generate the secrets that are missing (or explicitly rotated) and upload
 * them in one `wrangler secret bulk`, through stdin. Returns the new
 * bootstrap token, if one was set.
 */
async function setSecrets(env: string | undefined, vapidSubject: string): Promise<string | null> {
  const have = await existingSecrets(env);
  const secrets: Record<string, string> = {};
  if (!have.has('TOKEN_PEPPER')) secrets.TOKEN_PEPPER = randomSecret(48);
  else if (
    confirm(
      'TOKEN_PEPPER exists. Rotate it? This logs everyone out and voids all links and tokens',
      false,
    )
  ) {
    secrets.TOKEN_PEPPER = randomSecret(48);
  }
  let setupToken: string | null = null;
  if (
    !have.has('BOOTSTRAP_ADMIN_TOKEN') ||
    confirm(
      'BOOTSTRAP_ADMIN_TOKEN exists. Make a new one (only useful while no admin exists)?',
      false,
    )
  ) {
    setupToken = randomSecret(24);
    secrets.BOOTSTRAP_ADMIN_TOKEN = setupToken;
  }
  if (!have.has('VAPID_PUBLIC_KEY') || !have.has('VAPID_PRIVATE_KEY')) {
    const vapid = await generateVapidKeys();
    secrets.VAPID_PUBLIC_KEY = vapid.publicKey;
    secrets.VAPID_PRIVATE_KEY = vapid.privateKey;
  }
  if (vapidSubject) secrets.VAPID_SUBJECT = vapidSubject;
  const names = Object.keys(secrets);
  if (!names.length) {
    console.log('All Worker secrets are already set; kept them.');
    return null;
  }
  await wrangler(['secret', 'bulk', '--env', env ?? ''], {
    stdin: JSON.stringify(secrets),
    echo: true,
  });
  console.log(`Set ${names.join(', ')}.`);
  return setupToken;
}

/** A dashboard link that opens "Create API token" with the permissions CI needs. */
function tokenTemplateUrl(customDomain: boolean, name: string): string {
  const perms = [
    { key: 'workers_scripts', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'account_settings', type: 'read' },
    ...(customDomain
      ? [
          { key: 'workers_routes', type: 'edit' },
          { key: 'dns', type: 'edit' },
        ]
      : []),
  ];
  const q = `permissionGroupKeys=${encodeURIComponent(JSON.stringify(perms))}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`;
  return `https://dash.cloudflare.com/profile/api-tokens?${q}`;
}

/** Check a pasted API token: active, and able to see this account's D1 and Workers. */
async function verifyApiToken(token: string, accountId: string): Promise<string | null> {
  const get = async (path: string) => {
    const res = await fetch(`${CF_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return (await res.json().catch(() => ({ success: false }))) as {
      success: boolean;
      result?: { status?: string };
    };
  };
  const user = await get('/user/tokens/verify');
  const verified = user.success ? user : await get(`/accounts/${accountId}/tokens/verify`);
  if (!verified.success || verified.result?.status !== 'active')
    return 'the token is not valid or not active';
  if (!(await get(`/accounts/${accountId}/d1/database`)).success)
    return 'the token cannot access D1 in this account';
  if (!(await get(`/accounts/${accountId}/workers/scripts`)).success)
    return 'the token cannot access Workers in this account';
  return null;
}

async function githubRepo(): Promise<string | null> {
  if (!Bun.which('gh')) {
    console.log('`gh` is not installed: the GitHub settings are printed instead of set.');
    return null;
  }
  if (!(await exec(['gh', 'auth', 'status'], { allowFail: true })).ok) {
    console.log(
      '`gh` is not logged in (`gh auth login`): the GitHub settings are printed instead.',
    );
    return null;
  }
  const r = await exec(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    allowFail: true,
  });
  const repo = ask(
    'GitHub repository to configure (OWNER/REPO; empty = skip)',
    r.ok ? r.out.trim() : '',
  );
  return repo || null;
}

// ── Main ───────────────────────────────────────────────────────────────

console.log('Someday bootstrap: Cloudflare Worker + D1, and the GitHub repo that deploys it.');

step('Cloudflare account');
const whoami = await exec(['bunx', 'wrangler', 'whoami', '--json'], { allowFail: true });
if (!whoami.ok) {
  console.error('Not logged in to Cloudflare. Run `bunx wrangler login` and try again.');
  process.exit(1);
}
const accounts =
  (JSON.parse(whoami.out) as { accounts?: { id: string; name: string }[] }).accounts ?? [];
if (!accounts.length) throw new Error('No Cloudflare account found for this login.');
const prev = readEnvFile();
let accountId =
  prev.CLOUDFLARE_ACCOUNT_ID && accounts.some((a) => a.id === prev.CLOUDFLARE_ACCOUNT_ID)
    ? prev.CLOUDFLARE_ACCOUNT_ID
    : accounts[0]!.id;
if (accounts.length > 1) {
  for (const [i, a] of accounts.entries()) console.log(`  ${i + 1}) ${a.name} (${a.id})`);
  const def = String(accounts.findIndex((a) => a.id === accountId) + 1);
  accountId = accounts[Number(ask('Which account?', def)) - 1]?.id ?? accountId;
}
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
console.log(`Account: ${accounts.find((a) => a.id === accountId)?.name} (${accountId})`);

step('Settings');
const remote = await exec(['git', 'remote', 'get-url', 'origin'], { allowFail: true });
const remoteUrl = remote.ok
  ? remote.out
      .trim()
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '')
  : '';
const workerName = ask('Worker name', prev.WORKER_NAME || 'someday');
const customDomain = ask(
  'Custom domain (its DNS zone must be on Cloudflare; empty = use *.workers.dev)',
  prev.CUSTOM_DOMAIN ?? '',
);
const sourceUrl = ask(
  'Source code URL shown in the footer (your fork, if you change the code: AGPL §13)',
  prev.SOURCE_URL || remoteUrl || 'https://github.com/olemd/someday',
);
const vapidSubject = ask(
  'Contact address for push services (mailto:… or https://…; empty = the site address)',
  '',
);
const withPreview = confirm(
  'Also set up a preview environment for pull requests labelled "preview"?',
  !!prev.D1_PREVIEW_DATABASE_ID,
);

step('D1 database');
const databaseId = await findOrCreateD1(workerName);
const previewDatabaseId = withPreview ? await findOrCreateD1(`${workerName}-preview`) : '';

const values: Record<string, string> = {
  WORKER_NAME: workerName,
  PUBLIC_ORIGIN: customDomain
    ? `https://${customDomain}`
    : prev.PUBLIC_ORIGIN || 'https://pending.invalid',
  D1_DATABASE_ID: databaseId,
  CUSTOM_DOMAIN: customDomain,
  SOURCE_URL: sourceUrl,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  ...(withPreview
    ? {
        D1_PREVIEW_DATABASE_ID: previewDatabaseId,
        PREVIEW_ORIGIN: prev.PREVIEW_ORIGIN || 'https://pending.invalid',
      }
    : {}),
};
writeEnvFile(values);

step('Build, migrate and deploy');
await run(['bun', 'run', 'build']);
await run(['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']);
let deployOut = (await run(['bunx', 'wrangler', 'deploy', '--env', ''])).out;
if (!customDomain) {
  const url = workersDevUrl(deployOut);
  const origin =
    url ?? ask('Could not read the *.workers.dev address. Public origin of the Worker');
  if (origin !== values.PUBLIC_ORIGIN) {
    values.PUBLIC_ORIGIN = origin;
    writeEnvFile(values);
    console.log(`PUBLIC_ORIGIN = ${origin}; deploying again with it.`);
    await run(['bun', 'run', 'render-config']);
    deployOut = (await run(['bunx', 'wrangler', 'deploy', '--env', ''])).out;
  }
}
const origin = values.PUBLIC_ORIGIN!;

step('Worker secrets');
const setupToken = await setSecrets(undefined, vapidSubject);

let previewSetup: string | null = null;
if (withPreview) {
  step('Preview environment');
  await run([
    'bunx',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--remote',
    '--env',
    'preview',
  ]);
  const out = (await run(['bunx', 'wrangler', 'deploy', '--env', 'preview'])).out;
  const url = workersDevUrl(out) ?? ask('Public origin of the preview Worker');
  if (url !== values.PREVIEW_ORIGIN) {
    values.PREVIEW_ORIGIN = url;
    writeEnvFile(values);
    await run(['bun', 'run', 'render-config']);
    await run(['bunx', 'wrangler', 'deploy', '--env', 'preview']);
  }
  previewSetup = await setSecrets('preview', vapidSubject);
}

step('GitHub');
const variables: Record<string, string> = {
  PUBLIC_ORIGIN: origin,
  D1_DATABASE_ID: databaseId,
  WORKER_NAME: workerName,
  SOURCE_URL: sourceUrl,
  ...(customDomain ? { CUSTOM_DOMAIN: customDomain } : {}),
  ...(withPreview
    ? { PREVIEW_ORIGIN: values.PREVIEW_ORIGIN!, D1_PREVIEW_DATABASE_ID: previewDatabaseId }
    : {}),
};
const repo = await githubRepo();
const tokenUrl = tokenTemplateUrl(!!customDomain, `${workerName} deploy (GitHub Actions)`);
if (repo) {
  for (const [k, v] of Object.entries(variables)) {
    await exec(['gh', 'variable', 'set', k, '--repo', repo, '--body', v]);
    console.log(`  variable ${k}`);
  }
  await exec(['gh', 'secret', 'set', 'CLOUDFLARE_ACCOUNT_ID', '--repo', repo], {
    stdin: accountId,
  });
  console.log('  secret CLOUDFLARE_ACCOUNT_ID');

  const existing = await exec(
    ['gh', 'secret', 'list', '--repo', repo, '--json', 'name', '-q', '.[].name'],
    {
      allowFail: true,
    },
  );
  const hasToken = existing.out.split('\n').includes('CLOUDFLARE_API_TOKEN');
  if (!hasToken || confirm('CLOUDFLARE_API_TOKEN is already set. Replace it?', false)) {
    console.log(`
GitHub Actions needs a Cloudflare API token to deploy. Open this link, check
the permissions (and restrict it to your account/zone if you like), create the
token, and paste it below. It is verified, then sent straight to GitHub.

  ${tokenUrl}
`);
    for (;;) {
      const token = askHidden('Cloudflare API token (input hidden; empty = skip):');
      if (!token) {
        console.log('Skipped. Later: gh secret set CLOUDFLARE_API_TOKEN');
        break;
      }
      const problem = await verifyApiToken(token, accountId);
      if (problem) {
        console.log(`That did not work: ${problem}.`);
        continue;
      }
      await exec(['gh', 'secret', 'set', 'CLOUDFLARE_API_TOKEN', '--repo', repo], { stdin: token });
      console.log('  secret CLOUDFLARE_API_TOKEN (verified)');
      break;
    }
  }
  if (withPreview) {
    await exec([
      'gh',
      'label',
      'create',
      'preview',
      '--repo',
      repo,
      '--force',
      '--color',
      '0E8A16',
      '--description',
      'Deploy this PR to the preview environment',
    ]);
    console.log('  label "preview"');
  }
  if (confirm('Run the Deploy workflow on GitHub now to check that CI can deploy?', false)) {
    await run(['gh', 'workflow', 'run', 'deploy.yml', '--repo', repo]);
    console.log(`Follow it with: gh run watch --repo ${repo}`);
  }
} else {
  console.log(`Set these in GitHub → Settings → Secrets and variables → Actions:
  Secrets:   CLOUDFLARE_ACCOUNT_ID=${accountId}
             CLOUDFLARE_API_TOKEN=<create it here: ${tokenUrl}>
  Variables: ${Object.entries(variables)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n             ')}`);
}

step('Check');
// A new secret takes a moment to reach every isolate: retry for up to a minute.
type Health = { status: string; config_errors: string[] };
let health = null as Health | null;
for (let i = 0; i < 12; i++) {
  try {
    health = (await (await fetch(`${origin}/api/health`)).json()) as Health;
    if (health?.status === 'ok') break;
  } catch {
    // not reachable yet (DNS for a new custom domain can take a moment)
  }
  await Bun.sleep(5000);
}
if (health) {
  console.log(`${origin}/api/health → ${health.status}`);
  for (const e of health.config_errors) console.log(`  ! ${e}`);
} else {
  console.log(`${origin}/api/health did not answer yet; check it again in a few minutes.`);
}

console.log(`
Done.${
  setupToken
    ? `

Create the first admin account (the link works until an admin exists):
  ${origin}/setup?token=${setupToken}`
    : ''
}${
  previewSetup
    ? `

Preview environment admin:
  ${values.PREVIEW_ORIGIN}/setup?token=${previewSetup}`
    : ''
}

From now on, every push to main deploys through GitHub Actions.`);
