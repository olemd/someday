// SPDX-License-Identifier: AGPL-3.0-or-later
/** Same-origin JSON API client. Errors carry the server's {error, message, ...}. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; message?: string; [k: string]: unknown },
  ) {
    super(body.message ?? body.error);
  }
  get code() {
    return this.body.error;
  }
}

/** Thrown when the request never reached the server (offline). */
export class NetworkError extends Error {}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; json?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
      headers: opts.json !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError(String(err));
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body ?? { error: `http_${res.status}` });
  return body as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** Build a query string, skipping undefined/empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
