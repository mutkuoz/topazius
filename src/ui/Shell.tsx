import type { ComponentChildren } from 'preact';
import './shell.css';

export interface ShellProps {
  sidebar: ComponentChildren;
  main: ComponentChildren;
  status: ComponentChildren;
  onLock: () => void;
}

export function Shell({ sidebar, main, status, onLock }: ShellProps) {
  return (
    <div class="shell">
      <header class="shell-header">
        <strong>Topazius</strong>
        <span class="shell-status">{status}</span>
        <button type="button" onClick={onLock}>
          Lock
        </button>
      </header>
      <aside class="shell-sidebar">{sidebar}</aside>
      <main class="shell-main">{main}</main>
    </div>
  );
}
