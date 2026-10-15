// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared helpers for operator scripts (Bun only). */
import { toBase64Url } from '../src/core/crypto';

/** Generate a VAPID key pair (§8.4): P-256, public key raw uncompressed, private key as JWK `d`. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: toBase64Url(raw), privateKey: jwk.d! };
}

export function randomSetupToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/** Run wrangler (on Node, via its shebang) and return stdout; throws on failure. */
export async function wrangler(args: string[], opts: { stdin?: string } = {}): Promise<string> {
  const proc = Bun.spawn(['bunx', 'wrangler', ...args], {
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'inherit',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`wrangler ${args.join(' ')} failed`);
  return out;
}

export function ask(question: string, fallback = ''): string {
  const answer = prompt(fallback ? `${question} [${fallback}]` : question);
  return answer?.trim() || fallback;
}

export function confirmTyped(expected: string, question: string): boolean {
  return prompt(`${question}\nType "${expected}" to continue:`)?.trim() === expected;
}
