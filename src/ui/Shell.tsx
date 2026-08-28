import type { ComponentChildren } from 'preact';
import './shell.css';

export type Pane = 'files' | 'edit' | 'preview';

export interface ShellProps {
  header: ComponentChildren;
  sidebar: ComponentChildren;
  main: ComponentChildren;
  aside?: ComponentChildren;
  /** Which pane the phone layout shows; ignored above the breakpoint. */
  pane: Pane;
  onPane: (pane: Pane) => void;
  /** Hidden when the right-hand column is collapsed. */
  showAside: boolean;
  /** The note list can be collapsed to give the editor the whole window. */
  showSidebar: boolean;
}

/**
 * Three panes on a desktop, one at a time on a phone with a bottom tab bar
 * (spec §11.4). The layout is CSS grid; this component only decides which
 * slots exist and, on small screens, which one is on top.
 */
export function Shell({ header, sidebar, main, aside, pane, onPane, showAside, showSidebar }: ShellProps) {
  const classes = [
    'shell',
    showAside && aside ? 'with-aside' : '',
    showSidebar ? '' : 'no-sidebar',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div class={classes} data-pane={pane}>
      <header class="shell-header">{header}</header>

      {showSidebar && (
        <aside class="shell-sidebar" aria-label="Notes">
          {sidebar}
        </aside>
      )}

      <main class="shell-main">{main}</main>

      {showAside && aside && <aside class="shell-aside">{aside}</aside>}

      <nav class="shell-tabs" aria-label="Panes">
        {(['files', 'edit', 'preview'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            class={pane === candidate ? 'selected' : ''}
            aria-current={pane === candidate}
            onClick={() => onPane(candidate)}
          >
            {candidate === 'files' ? 'Files' : candidate === 'edit' ? 'Edit' : 'Preview'}
          </button>
        ))}
      </nav>
    </div>
  );
}
