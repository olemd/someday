// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Domain errors. Thrown from core/modules and mapped to JSON responses in one
 * place (the app's onError), so handlers never build error responses by hand.
 */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 503,
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, details?: Record<string, unknown>) =>
  new HttpError(400, code, message, details);
export const notFound = (what = 'not_found') => new HttpError(404, what);
export const conflict = (code: string, message?: string, details?: Record<string, unknown>) =>
  new HttpError(409, code, message, details);
