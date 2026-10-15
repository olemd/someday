// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared by scripts/e2e.ts and scripts/screenshots.ts: a throwaway
 * self-hosted server (temp SQLite database, built PWA from dist/web) and
 * Chromium contexts with a virtual WebAuthn authenticator, so real passkey
 * ceremonies work on http://localhost.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

export const BOOTSTRAP_TOKEN = 'local-bootstrap-token-0123456789';

export interface TestServer {
  origin: string;
  dir: string;
  stop(keep?: boolean): void;
}

export async function startServer(
  port: number,
  env: Record<string, string> = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'someday-browser-'));
  const origin = `http://localhost:${port}`;
  const proc = Bun.spawn(['bun', 'src/platform/bun/server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: join(dir, 'someday.db'),
      STATIC_DIR: 'dist/web',
      PUBLIC_ORIGIN: origin,
      TOKEN_PEPPER: 'local-pepper-local-pepper-local-pepper-0123',
      BOOTSTRAP_ADMIN_TOKEN: BOOTSTRAP_TOKEN,
      ...env,
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(`${origin}/healthz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await Bun.sleep(100);
  }
  return {
    origin,
    dir,
    stop(keep = false) {
      proc.kill();
      if (keep) console.log(`database kept in ${dir}`);
      else rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** CHROMIUM_PATH: use an installed Chromium instead of Playwright's download. */
export function launch(): Promise<Browser> {
  return chromium.launch({
    headless: !process.env.HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
}

/** A browser context whose page has its own platform passkey authenticator. */
export async function passkeyContext(
  browser: Browser,
  opts: Parameters<Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Oslo', ...opts });
  const page = await context.newPage();
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
  return { context, page };
}
