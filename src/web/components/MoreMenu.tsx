// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A "More" menu for rarely used actions, built on <details>/<summary> so it
 * works with keyboard and screen readers without ARIA menu machinery. It
 * closes after a choice, on Escape and on a click outside.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../lib/i18n';

export interface MoreAction {
  label: string;
  run: () => void | Promise<void>;
  danger?: boolean;
}

export function MoreMenu({ actions, label }: { actions: MoreAction[]; label?: ComponentChildren }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        d.open = false;
        d.querySelector('summary')?.focus();
        return;
      }
      if (!d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  if (!actions.length) return null;
  return (
    <details class="more-menu" ref={ref}>
      <summary class="btn plain">{label ?? t('common.more')}</summary>
      <ul class="plain">
        {actions.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              class={a.danger ? 'menu-item danger' : 'menu-item'}
              onClick={async () => {
                if (ref.current) ref.current.open = false;
                await a.run();
              }}
            >
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
