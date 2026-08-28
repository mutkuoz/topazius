import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  /** Renders as a link instead of a button — used for "open on GitHub". */
  href?: string;
  danger?: boolean;
  hint?: string;
}

export interface MenuButtonProps {
  label: string;
  items: MenuItem[];
  children: ComponentChildren;
}

/**
 * A button that drops a menu. Used where a right-click menu would otherwise be
 * the only way in — a context menu is invisible to anyone who does not think
 * to try it, and impossible on a touchscreen.
 */
export function MenuButton({ label, items, children }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocument(event: Event) {
      if (event.target instanceof Node && host.current?.contains(event.target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDocument);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocument);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div class="menu-host" ref={host}>
      <button
        type="button"
        class="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((was) => !was)}
      >
        {children}
      </button>

      {open && (
        <div class="menu" role="menu">
          {items.map((item) =>
            item.href ? (
              <a
                key={item.label}
                role="menuitem"
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                {item.label}
                {item.hint && <span class="menu-hint">{item.hint}</span>}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                class={item.danger ? 'danger' : ''}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
                {item.hint && <span class="menu-hint">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
