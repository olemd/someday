// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared helpers for operator scripts (Bun only). */
import { toBase64Url } from '../src/core/crypto';

/** Generate a VAPID key pair: P-256, public key raw uncompressed, private key as JWK `d`. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: toBase64Url(raw), privateKey: jwk.d! };
}

/** A URL-safe random secret with `bytes` bytes of entropy. */
export function randomSecret(bytes = 24): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Run a command; stdout is returned (and echoed when `echo`), stderr goes to
 * the terminal. `stdin` feeds secrets through a pipe, never through argv
 * (argv is visible to other users in the process list).
 */
export async function exec(
  cmd: string[],
  opts: { stdin?: string; echo?: boolean; allowFail?: boolean } = {},
): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'inherit',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  // Stream while capturing, so interactive prompts from the tool are visible.
  let out = '';
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    const text = decoder.decode(chunk, { stream: true });
    out += text;
    if (opts.echo) process.stdout.write(text);
  }
  const ok = (await proc.exited) === 0;
  if (!ok && !opts.allowFail) throw new Error(`${cmd.join(' ')} failed`);
  return { ok, out };
}

/** Run wrangler (on Node, via its shebang) and return stdout; throws on failure. */
export async function wrangler(
  args: string[],
  opts: { stdin?: string; echo?: boolean } = {},
): Promise<string> {
  return (await exec(['bunx', 'wrangler', ...args], opts)).out;
}

export function ask(question: string, fallback = ''): string {
  const answer = prompt(fallback ? `${question} [${fallback}]` : question);
  return answer?.trim() || fallback;
}

export function confirm(question: string, fallback = false): boolean {
  const a = ask(`${question} (${fallback ? 'Y/n' : 'y/N'})`, fallback ? 'y' : 'n').toLowerCase();
  return a === 'y' || a === 'yes' || a === 'j' || a === 'ja';
}

export function confirmTyped(expected: string, question: string): boolean {
  return prompt(`${question}\nType "${expected}" to continue:`)?.trim() === expected;
}

/** Read a line without echoing it (for tokens pasted into the terminal). */
export function askHidden(question: string): string {
  const tty = Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' }).success;
  try {
    return prompt(question)?.trim() ?? '';
  } finally {
    if (tty) {
      Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' });
      process.stdout.write('\n');
    }
  }
}
