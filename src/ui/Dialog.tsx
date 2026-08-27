import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import './dialog.css';

export interface DialogProps {
  title: string;
  children: ComponentChildren;
  onClose: () => void;
  /** Widen for side-by-side content such as the conflict view. */
  wide?: boolean;
  /** Modal dialogs refuse the backdrop click; used where a choice is required. */
  insistent?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal that traps focus and restores it on close (spec §11.5). Every dialog
 * in the app goes through this one, so the accessibility behaviour is written
 * once rather than approximated five times.
 */
export function Dialog({ title, children, onClose, wide, insistent }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    const focusable = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (focusable?.[0] ?? panel.current)?.focus();

    return () => {
      // Focus goes back where it came from, so keyboard users are not dropped
      // at the top of the document every time a dialog closes.
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable.at(-1) as HTMLElement;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div
      class="backdrop"
      onClick={(event) => {
        if (!insistent && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class={`dialog${wide ? ' dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
        tabIndex={-1}
      >
        <h2 class="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
