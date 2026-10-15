// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One app-wide modal built on native <dialog> (focus trap, Esc and inert
 * background for free). `ask()` resolves with the chosen value, or null when
 * dismissed, so 409 → ask → retry flows read linearly.
 */
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../lib/i18n';

export interface Choice<T> {
  label: string;
  value: T;
  variant?: 'primary' | 'danger' | 'plain';
}

interface Pending {
  title: string;
  body?: ComponentChildren;
  choices: Choice<unknown>[];
  resolve: (v: unknown) => void;
}

const pending = signal<Pending | null>(null);

export function ask<T>(
  title: string,
  choices: Choice<T>[],
  body?: ComponentChildren,
): Promise<T | null> {
  return new Promise((resolve) => {
    pending.value = { title, body, choices, resolve: resolve as (v: unknown) => void };
  });
}

export async function confirmAction(
  message: string,
  label: string,
  danger = false,
): Promise<boolean> {
  const r = await ask(message, [
    { label: t('common.cancel'), value: false, variant: 'plain' },
    { label, value: true, variant: danger ? 'danger' : 'primary' },
  ]);
  return r === true;
}

export function DialogHost() {
  const ref = useRef<HTMLDialogElement>(null);
  const p = pending.value;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (p && !d.open) {
      d.showModal();
      // Focus the primary action (the last choice; Cancel comes first).
      d.querySelector<HTMLButtonElement>('.actions button:last-child')?.focus();
    }
    if (!p && d.open) d.close();
  }, [p]);

  const finish = (v: unknown) => {
    const cur = pending.value;
    pending.value = null;
    cur?.resolve(v);
  };

  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="dialog-title"
      onClose={() => pending.value && finish(null)}
    >
      {p && (
        <form method="dialog" class="stack" onSubmit={(e) => e.preventDefault()}>
          <h2 id="dialog-title" class="dialog-title">
            {p.title}
          </h2>
          {p.body}
          <div class="actions">
            {p.choices.map((c, i) => (
              <button
                key={i}
                type="button"
                class={`btn ${c.variant ?? 'plain'}`}
                onClick={() => finish(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </form>
      )}
    </dialog>
  );
}
