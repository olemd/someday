// SPDX-License-Identifier: AGPL-3.0-or-later
/** Polite live region for confirmations and errors, with an optional action (undo). */
import { signal } from '@preact/signals';
import { ApiError, NetworkError } from '../lib/api';
import { t } from '../lib/i18n';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

const toasts = signal<Toast[]>([]);
let next = 1;

export function toast(
  text: string,
  opts: { kind?: 'info' | 'error'; action?: Toast['action']; ms?: number } = {},
) {
  // The same message twice in a row (e.g. two queued actions) is shown once.
  if (!opts.action && toasts.value.some((x) => x.text === text)) return;
  const id = next++;
  toasts.value = [...toasts.value, { id, text, kind: opts.kind ?? 'info', action: opts.action }];
  setTimeout(() => dismiss(id), opts.ms ?? (opts.action ? 10_000 : 5_000));
}

function dismiss(id: number) {
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

/** Show any error in plain words. */
export function showError(err: unknown) {
  if (err instanceof NetworkError) return toast(t('common.networkError'), { kind: 'error' });
  if (err instanceof ApiError) {
    if (err.code === 'rate_limited') return toast(t('auth.rateLimited'), { kind: 'error' });
    return toast(t('common.error', { message: err.message }), { kind: 'error' });
  }
  toast(t('common.error', { message: String(err) }), { kind: 'error' });
}

export function ToastHost() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((x) => (
        <div key={x.id} class={`toast ${x.kind}`}>
          <span>{x.text}</span>
          {x.action && (
            <button
              type="button"
              class="btn plain small"
              onClick={() => {
                x.action!.run();
                dismiss(x.id);
              }}
            >
              {x.action.label}
            </button>
          )}
          <button
            type="button"
            class="icon-btn"
            aria-label={t('common.close')}
            onClick={() => dismiss(x.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
