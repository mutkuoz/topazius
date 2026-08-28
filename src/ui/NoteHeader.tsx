import { MenuButton } from './Menu';
import { ExternalIcon, LockIcon, MoreIcon } from './icons';

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'offline' | 'conflict' | 'error';

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved',
  saving: 'Saving…',
  offline: 'Offline — will save',
  conflict: 'Conflict',
  error: 'Not saved',
};

export type ViewMode = 'edit' | 'split' | 'preview';

export interface NoteHeaderProps {
  path: string;
  title: string;
  encrypted: boolean;
  save: SaveState;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  /** Clicking a folder in the path filters the tree to it. */
  onOpenFolder: (folder: string) => void;
  onRename: () => void;
  onDelete: () => void;
  onToggleEncryption: () => void;
  /** The note on GitHub, and its history. Absent while it has never been pushed. */
  links: { file: string; history: string } | null;
}

/**
 * Which note is open, where it lives, and whether it is safe.
 *
 * This bar exists because none of that was visible anywhere before: the tree
 * highlighted a row, and that was the whole answer to "what am I editing?".
 */
export function NoteHeader({
  path,
  title,
  encrypted,
  save,
  view,
  onView,
  onOpenFolder,
  onRename,
  onDelete,
  onToggleEncryption,
  links,
}: NoteHeaderProps) {
  const segments = path.split('/');
  const fileName = segments.pop() ?? path;

  return (
    <header class="note-header">
      <div class="note-id">
        <h1 class="note-title" title={title}>
          {title}
          {encrypted && (
            <span class="note-encrypted" title="Encrypted — GitHub stores only ciphertext">
              <LockIcon />
              encrypted
            </span>
          )}
        </h1>

        <p class="note-path">
          {segments.map((segment, index) => {
            const folder = segments.slice(0, index + 1).join('/');
            return (
              <span key={folder}>
                <button type="button" class="crumb" onClick={() => onOpenFolder(folder)}>
                  {segment}
                </button>
                <span class="crumb-sep" aria-hidden="true">
                  /
                </span>
              </span>
            );
          })}
          <span class="crumb-file">{fileName}</span>
          <span class={`save-state save-${save}`} role="status">
            {SAVE_LABEL[save]}
          </span>
        </p>
      </div>

      <div class="note-tools">
        <div class="view-switch" role="group" aria-label="View">
          {(['edit', 'split', 'preview'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              class={view === mode ? 'selected' : ''}
              aria-pressed={view === mode}
              title={mode === 'split' ? 'Editor and preview · ⌘P' : `${mode} only · ⌘P`}
              onClick={() => onView(mode)}
            >
              {mode === 'edit' ? 'Write' : mode === 'split' ? 'Split' : 'Read'}
            </button>
          ))}
        </div>

        {links && (
          <a
            class="icon-button"
            href={links.file}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this file on GitHub"
            aria-label="Open this file on GitHub"
          >
            <ExternalIcon />
          </a>
        )}

        <MenuButton
          label="Note actions"
          items={[
            { label: 'Rename or move…', onSelect: onRename },
            {
              label: encrypted ? 'Decrypt this note' : 'Encrypt this note',
              onSelect: onToggleEncryption,
            },
            ...(links ? [{ label: 'History on GitHub', href: links.history }] : []),
            { label: 'Delete…', onSelect: onDelete, danger: true },
          ]}
        >
          <MoreIcon />
        </MenuButton>
      </div>
    </header>
  );
}
