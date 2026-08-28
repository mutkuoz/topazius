import { useId, useState } from 'preact/hooks';
import { titleToFileName } from '../lib/paths';
import { Dialog } from './Dialog';

/**
 * Where a note will land, given what the user typed.
 *
 * The point of this function is that the dialogs never ask anyone to type a
 * path. A title is a title; the extension is the app's business, and a `/` in
 * the title is read as the folder the user clearly meant.
 */
export function plannedPath(input: {
  title: string;
  folder: string;
  encrypted: boolean;
}): string {
  const typed = input.title.trim().replace(/\.md(\.enc)?$/i, '');
  const parts = typed.split('/').filter((part) => part.trim() !== '');
  const name = titleToFileName(parts.pop() ?? '');

  const folders = [...input.folder.split('/'), ...parts]
    .map((part) => titleToFileName(part))
    .filter((part) => part !== '' && part !== 'Untitled');

  const extension = input.encrypted ? '.md.enc' : '.md';
  return [...folders, `${name}${extension}`].join('/');
}

/** Every folder that exists in the vault, for the folder field's suggestions. */
export function foldersIn(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/').slice(0, -1);
    for (let index = 0; index < segments.length; index++) {
      folders.add(segments.slice(0, index + 1).join('/'));
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}

interface FieldsProps {
  title: string;
  folder: string;
  encrypted: boolean;
  folders: string[];
  /** Absent when this vault has no encryption set up and none is offered. */
  onEncrypted?: (value: boolean) => void;
  onTitle: (value: string) => void;
  onFolder: (value: string) => void;
  listId: string;
}

function Fields({ title, folder, encrypted, folders, onTitle, onFolder, onEncrypted, listId }: FieldsProps) {
  return (
    <>
      <label>
        Title
        <input
          value={title}
          placeholder="Weekly standup"
          onInput={(event) => onTitle(event.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
          required
        />
      </label>

      <label>
        Folder
        <input
          value={folder}
          list={listId}
          placeholder="(the top of the vault)"
          onInput={(event) => onFolder(event.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
        />
      </label>
      <datalist id={listId}>
        {folders.map((candidate) => (
          <option key={candidate} value={candidate} />
        ))}
      </datalist>

      {onEncrypted && (
        <label class="checkbox">
          <input
            type="checkbox"
            checked={encrypted}
            onChange={(event) => onEncrypted(event.currentTarget.checked)}
          />
          Encrypt this note
        </label>
      )}
    </>
  );
}

export interface NoteDialogProps {
  /** Every note path in the vault, for folder suggestions. */
  paths: readonly string[];
  /** Pre-filled folder — the one the user was looking at. */
  folder?: string;
  /** Pre-filled title — used when creating a note from a missing wikilink. */
  title?: string;
  /** Whether an "encrypt this note" checkbox is offered at all. */
  canEncrypt?: boolean;
  encrypted?: boolean;
  onSubmit: (path: string) => Promise<unknown>;
  onCancel: () => void;
}

/** Create a note: a title, a folder, and the resulting path shown as you type. */
export function NewNoteDialog({
  paths,
  folder: initialFolder = '',
  title: initialTitle = '',
  canEncrypt,
  encrypted: initialEncrypted = false,
  onSubmit,
  onCancel,
}: NoteDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [folder, setFolder] = useState(initialFolder);
  const [encrypted, setEncrypted] = useState(initialEncrypted);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();

  const path = plannedPath({ title, folder, encrypted });
  const exists = paths.some((candidate) => candidate === path);

  async function submit(event: Event) {
    event.preventDefault();
    if (title.trim() === '') {
      setError('Give the note a title.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New note" onClose={onCancel}>
      <form class="stack" onSubmit={submit}>
        <Fields
          title={title}
          folder={folder}
          encrypted={encrypted}
          folders={foldersIn(paths)}
          onTitle={(value) => {
            setTitle(value);
            setError(null);
          }}
          onFolder={setFolder}
          {...(canEncrypt ? { onEncrypted: setEncrypted } : {})}
          listId={listId}
        />

        <p class="path-preview">
          <span class="hint">Saved as</span> <code>{path}</code>
        </p>
        {exists && (
          <p class="warn" role="status">
            A note already lives there. Choose another title or folder.
          </p>
        )}
        {error && (
          <p class="alert" role="alert">
            {error}
          </p>
        )}

        <div class="dialog-actions">
          <button type="submit" disabled={busy || exists}>
            {busy ? 'Creating…' : 'Create note'}
          </button>
          <button type="button" class="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export interface RenameDialogProps {
  path: string;
  paths: readonly string[];
  onSubmit: (path: string) => Promise<unknown>;
  onCancel: () => void;
}

/**
 * Rename and move, in the same two fields as creating — and never a chance to
 * change the note's encryption by editing its extension, which is a decision
 * that belongs to the lock button and its ceremony.
 */
export function RenameNoteDialog({ path, paths, onSubmit, onCancel }: RenameDialogProps) {
  const encrypted = path.endsWith('.enc');
  const segments = path.split('/');
  const fileName = segments.pop() ?? path;

  const [title, setTitle] = useState(fileName.replace(/\.md(\.enc)?$/i, ''));
  const [folder, setFolder] = useState(segments.join('/'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();

  const next = plannedPath({ title, folder, encrypted });
  const exists = next !== path && paths.some((candidate) => candidate === next);

  async function submit(event: Event) {
    event.preventDefault();
    if (next === path) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Rename or move" onClose={onCancel}>
      <form class="stack" onSubmit={submit}>
        <Fields
          title={title}
          folder={folder}
          encrypted={encrypted}
          folders={foldersIn(paths)}
          onTitle={(value) => {
            setTitle(value);
            setError(null);
          }}
          onFolder={setFolder}
          listId={listId}
        />

        <p class="path-preview">
          <span class="hint">Saved as</span> <code>{next}</code>
        </p>
        <p class="hint">
          Links to this note in other notes are updated for you.
          {encrypted ? ' It stays encrypted, and is re-sealed under its new path.' : ''}
        </p>
        {exists && (
          <p class="warn" role="status">
            A note already lives there. Choose another title or folder.
          </p>
        )}
        {error && (
          <p class="alert" role="alert">
            {error}
          </p>
        )}

        <div class="dialog-actions">
          <button type="submit" disabled={busy || exists}>
            {busy ? 'Moving…' : 'Rename'}
          </button>
          <button type="button" class="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
