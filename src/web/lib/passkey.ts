// SPDX-License-Identifier: AGPL-3.0-or-later
/** Browser side of the passkey ceremonies (§2.1). */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { post } from './api';
import { t } from './i18n';

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Turn a WebAuthn/browser failure into a message for the user. */
export function passkeyErrorMessage(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string };
  if (
    e.name === 'NotAllowedError' ||
    e.name === 'AbortError' ||
    e.code === 'ERROR_CEREMONY_ABORTED'
  ) {
    return t('auth.cancelled');
  }
  if (e.name === 'InvalidStateError' || e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
    return t('auth.alreadyRegistered');
  }
  return t('auth.failed', { message: e.message ?? String(err) });
}

type Json = Record<string, unknown>;

/** Create an account: setup (bootstrap token), invite or open registration. */
export async function signup(
  kind: 'setup' | 'invite' | 'open' | 'join',
  displayName: string,
  label: string,
  token?: string,
): Promise<string[]> {
  const options = await post<Json>('/auth/signup/options', {
    kind,
    token,
    display_name: displayName,
  });
  const response = await startRegistration({ optionsJSON: options as never });
  const r = await post<{ recovery_codes: string[] }>('/auth/signup/verify', {
    response,
    label,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language.toLowerCase().startsWith('n') ? 'nb' : 'en',
  });
  return r.recovery_codes;
}

/** Add a passkey on this device to the logged-in account. */
export async function addPasskey(label: string): Promise<void> {
  const options = await post<Json>('/auth/register/options');
  const response = await startRegistration({ optionsJSON: options as never });
  await post('/auth/register/verify', { response, label });
}

export async function loginWithPasskey(): Promise<void> {
  const options = await post<Json>('/auth/login/options');
  const response = await startAuthentication({ optionsJSON: options as never });
  await post('/auth/login/verify', { response });
}

/** A fresh assertion for sensitive actions (device links, deletion, new codes). */
export async function reauthenticate(): Promise<void> {
  const options = await post<Json>('/auth/reauth/options');
  const response = await startAuthentication({ optionsJSON: options as never });
  await post('/auth/reauth/verify', { response });
}

/** Register this device's passkey through a claimed device link. */
export async function registerViaLink(claim: string, label: string): Promise<void> {
  const options = await post<Json>('/links/claim/options', { claim });
  const response = await startRegistration({ optionsJSON: options as never });
  await post('/links/claim/verify', { claim, response, label });
}

/** A readable default label for a new passkey ("Firefox on Linux"). */
export function defaultPasskeyLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return browser && os
    ? t('auth.labelOn', { browser, os })
    : browser || os || t('auth.labelDefault');
}
