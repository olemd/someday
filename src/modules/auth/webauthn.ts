// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared WebAuthn plumbing for signup, login, re-auth, adding passkeys and
 * device links: single-use challenges with context, and verification
 * wrappers that turn library errors into HTTP errors.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { fromBase64Url } from '../../core/crypto';
import { HttpError, badRequest } from '../../core/errors';
import { iso } from '../../core/ports';
import type { Ctx } from '../types';

const CHALLENGE_TTL_MS = 5 * 60_000;

export type ChallengeKind = 'signup' | 'login' | 'reauth' | 'register' | 'link';

export async function storeChallenge(
  ctx: Ctx,
  challenge: string,
  kind: ChallengeKind,
  userId: string | null,
  data: Record<string, unknown> | null = null,
): Promise<void> {
  await ctx.db.run(
    'INSERT INTO auth_challenges (challenge, kind, user_id, data, expires_at) VALUES (?, ?, ?, ?, ?)',
    challenge,
    kind,
    userId,
    data ? JSON.stringify(data) : null,
    iso(ctx.clock.now() + CHALLENGE_TTL_MS),
  );
}

interface ConsumedChallenge {
  userId: string | null;
  data: Record<string, unknown>;
}

/**
 * A challenge checker for @simplewebauthn: only the request whose DELETE
 * removes the row may proceed (single use). The consumed row's context is
 * returned through `result`.
 */
function consumer(ctx: Ctx, kind: ChallengeKind, userId: string | null) {
  const result: { value: ConsumedChallenge | null } = { value: null };
  const check = async (challenge: string) => {
    const rows = await ctx.db.batch([
      {
        sql: 'SELECT user_id, data FROM auth_challenges WHERE challenge = ? AND kind = ? AND expires_at > ?',
        params: [challenge, kind, iso(ctx.clock.now())],
      },
      {
        sql: 'DELETE FROM auth_challenges WHERE challenge = ? AND kind = ? AND expires_at > ?',
        params: [challenge, kind, iso(ctx.clock.now())],
      },
    ]);
    const row = rows[0]?.rows[0] as { user_id: string | null; data: string | null } | undefined;
    if (!row || rows[1]?.changes !== 1) return false;
    if (userId !== null && row.user_id !== userId) return false;
    result.value = {
      userId: row.user_id,
      data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {},
    };
    return true;
  };
  return { check, result };
}

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string | null;
}

const transportsOf = (t: string | null) =>
  t ? (JSON.parse(t) as AuthenticatorTransport[]) : undefined;

export async function registrationOptions(
  ctx: Ctx,
  user: { handle: string; name: string },
  existingUserId: string | null,
) {
  const existing = existingUserId
    ? await ctx.db.all<{ id: string; transports: string | null }>(
        'SELECT id, transports FROM passkeys WHERE user_id = ?',
        existingUserId,
      )
    : [];
  return generateRegistrationOptions({
    rpName: ctx.config.RP_NAME,
    rpID: ctx.config.RP_ID,
    userName: user.name,
    userDisplayName: user.name,
    userID: fromBase64Url(user.handle),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: transportsOf(p.transports) })),
  });
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string | null;
  challenge: ConsumedChallenge;
}

export async function verifyRegistration(
  ctx: Ctx,
  response: unknown,
  kind: ChallengeKind,
  userId: string | null,
): Promise<VerifiedRegistration> {
  const { check, result } = consumer(ctx, kind, userId);
  let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: check,
      expectedOrigin: ctx.config.PUBLIC_ORIGIN,
      expectedRPID: ctx.config.RP_ID,
      requireUserVerification: true,
    });
  } catch (err) {
    throw badRequest('webauthn_failed', String((err as Error).message ?? err));
  }
  if (!v.verified || !result.value)
    throw badRequest('webauthn_failed', 'Registration not verified');
  const { credential } = v.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    challenge: result.value,
  };
}

/** INSERT for a verified passkey, optionally gated by an EXISTS condition. */
export function passkeyInsert(
  ctx: Ctx,
  reg: VerifiedRegistration,
  userId: string,
  label: string,
  gate?: { sql: string; params: (string | number | null)[] },
) {
  return {
    sql: `INSERT INTO passkeys (id, user_id, public_key, counter, transports, label, created_at, last_used_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? ${gate ? `WHERE ${gate.sql}` : ''}`,
    params: [
      reg.credentialId,
      userId,
      reg.publicKey,
      reg.counter,
      reg.transports,
      label,
      iso(ctx.clock.now()),
      iso(ctx.clock.now()),
      ...(gate?.params ?? []),
    ],
  };
}

export async function authenticationOptions(ctx: Ctx, userId: string | null) {
  const allow = userId
    ? await ctx.db.all<{ id: string; transports: string | null }>(
        'SELECT id, transports FROM passkeys WHERE user_id = ?',
        userId,
      )
    : [];
  return generateAuthenticationOptions({
    rpID: ctx.config.RP_ID,
    userVerification: 'required',
    allowCredentials: allow.map((p) => ({ id: p.id, transports: transportsOf(p.transports) })),
  });
}

/** Verify an assertion; returns the passkey's ID and owner. Updates counter and last use. */
export async function verifyAssertion(
  ctx: Ctx,
  response: unknown,
  kind: ChallengeKind,
  userId: string | null,
): Promise<{ passkeyId: string; userId: string }> {
  const r = response as AuthenticationResponseJSON;
  const pk = await ctx.db.first<PasskeyRow>(
    'SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?',
    String(r?.id ?? ''),
  );
  if (!pk || (userId !== null && pk.user_id !== userId)) {
    throw new HttpError(401, 'unknown_passkey', 'This passkey is not registered here');
  }
  const { check } = consumer(ctx, kind, userId);
  let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    v = await verifyAuthenticationResponse({
      response: r,
      expectedChallenge: check,
      expectedOrigin: ctx.config.PUBLIC_ORIGIN,
      expectedRPID: ctx.config.RP_ID,
      requireUserVerification: true,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(pk.public_key),
        counter: pk.counter,
        transports: transportsOf(pk.transports),
      },
    });
  } catch (err) {
    throw new HttpError(401, 'webauthn_failed', String((err as Error).message ?? err));
  }
  if (!v.verified) throw new HttpError(401, 'webauthn_failed', 'Passkey not verified');
  await ctx.db.run(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?',
    v.authenticationInfo.newCounter,
    iso(ctx.clock.now()),
    pk.id,
  );
  return { passkeyId: pk.id, userId: pk.user_id };
}
