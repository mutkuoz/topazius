import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { slugify } from '../lib/paths';
import { tagCounts } from '../lib/tags';
import type { Vault } from '../lib/vault';
import type { Conflict } from '../lib/conflict';
import { ConflictDialog } from './ConflictDialog';
import { Editor } from './Editor';
import { InstallButton } from './Install';
import { RecoveryKeyShown, SetupEncryption, UnlockVaultKey } from './Encryption';
import { Backlinks, StatusChip, TagBar } from './Panels';
import { Palette, type PaletteAction } from './Palette';
import { Preview } from './Preview';
import { Confirm, Prompt } from './Prompt';
import { Shell, type Pane } from './Shell';
import { Tree, type TreeAction } from './Tree';
import './workspace.css';

export interface WorkspaceProps {
  vault: Vault;
  onLock: () => void;
  /** The repository this vault points at, for the header. */
  label: string;
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'new'; folder: string; initial?: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'encrypt-setup'; then: () => void }
  | { kind: 'unlock-key' }
  | { kind: 'recovery'; key: string }
  | { kind: 'conflict'; conflict: Conflict }
  | { kind: 'batch'; title: string; body: string };

interface Doc {
  path: string;
  text: string;
  error?: string;
}

/** The unlocked app: tree, editor, preview, and every dialog they can raise. */
export function Workspace({ vault, onLock, label }: WorkspaceProps) {
  // A render counter: the vault holds the state, this only asks Preact to
  // look at it again.
  const [, bump] = useReducer((count: number, _: unknown): number => count + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [pane, setPane] = useState<Pane>('files');
  const [showPreview, setShowPreview] = useState(true);
  const [livePreview, setLivePreview] = useState(true);
  const [showBacklinks, setShowBacklinks] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const toastId = useRef(0);
  const handled = useRef(new Set<string>());
  const insertIntoEditor = useRef<((text: string) => void) | null>(null);

  const state = vault.state();

  useEffect(() => vault.subscribe(() => bump(null)), [vault]);

  const toast = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, text }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 6000);
  }, []);

  /** Load a note's text; a note that cannot be opened says so rather than blanking. */
  const open = useCallback(
    (path: string) => {
      setSelected(path);
      setPane('edit');
      vault
        .read(path)
        .then((text) => setDoc({ path, text }))
        .catch((error: unknown) =>
          setDoc({
            path,
            text: '',
            error: error instanceof Error ? error.message : 'Could not open this note.',
          }),
        );
    },
    [vault],
  );

  // A conflict is a decision the user has to make, so it is modal (spec §13).
  useEffect(() => {
    const pending = state.conflicts.find((path) => !handled.current.has(path));
    if (!pending || dialog.kind !== 'none') return;
    handled.current.add(pending);
    void vault
      .conflictFor(pending)
      .then((conflict) => setDialog({ kind: 'conflict', conflict }))
      .catch((error: unknown) =>
        toast(error instanceof Error ? error.message : 'Could not read the conflicting note.'),
      );
  }, [state.conflicts, dialog.kind, vault, toast]);

  const save = useCallback(
    (text: string, path: string) => {
      void vault.save(path, text).catch((error: unknown) => {
        toast(error instanceof Error ? error.message : 'Could not save that note.');
      });
      setDoc((current) => (current && current.path === path ? { ...current, text } : current));
    },
    [vault, toast],
  );

  const addFiles = useCallback(
    (files: File[], path: string) => {
      void (async () => {
        for (const file of files) {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const prepared = await vault.addImage(
              { bytes: bytes as Uint8Array<ArrayBuffer>, mime: file.type, name: file.name },
              path,
            );

            const insert = insertIntoEditor.current;
            if (insert) {
              // Into the live document, at the cursor (spec §8.3). The editor's
              // own change path saves it, so nothing here can overwrite an edit
              // still sitting inside the save debounce.
              insert(prepared.markdown);
            } else {
              const current = await vault.read(path);
              const next = `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${prepared.markdown}\n`;
              await vault.save(path, next);
              setDoc((doc) => (doc && doc.path === path ? { ...doc, text: next } : doc));
            }
          } catch (error) {
            toast(error instanceof Error ? error.message : 'That image could not be added.');
          }
        }
      })();
    },
    [vault, toast],
  );

  const loadImage = useCallback(
    (src: string) => (selected ? vault.assetBytes(selected, src) : Promise.resolve(null)),
    [vault, selected],
  );

  /** Ensure the vault key exists before an action that needs it. */
  const withVaultKey = useCallback(
    (run: () => void) => {
      if (state.sealed === 'open') {
        run();
        return;
      }
      if (state.sealed === 'locked' && state.hasVaultKeyFile) {
        setDialog({ kind: 'unlock-key' });
        return;
      }
      setDialog({ kind: 'encrypt-setup', then: run });
    },
    [state.sealed, state.hasVaultKeyFile],
  );

  const onTreeAction = useCallback(
    (action: TreeAction) => {
      switch (action.kind) {
        case 'new':
          setDialog({ kind: 'new', folder: action.folder });
          return;
        case 'rename':
          setDialog({ kind: 'rename', path: action.path });
          return;
        case 'delete':
          setDialog({ kind: 'delete', path: action.path });
          return;
        case 'encrypt':
          withVaultKey(() => {
            void vault
              .setEncrypted(action.path, action.on)
              .then((path) => {
                if (selected === action.path) open(path);
                toast(action.on ? 'Note encrypted.' : 'Note decrypted.');
              })
              .catch((error: unknown) =>
                toast(error instanceof Error ? error.message : 'Could not change that note.'),
              );
          });
          return;
        case 'encrypt-folder':
          withVaultKey(() => {
            void vault
              .encryptFolder(action.folder, action.on)
              .then((report) =>
                setDialog({
                  kind: 'batch',
                  title: action.on ? 'Folder encrypted' : 'Folder decrypted',
                  body:
                    report.failed.length === 0
                      ? `${report.done.length} note${report.done.length === 1 ? '' : 's'} changed.`
                      : `${report.done.length} changed. These did not: ${report.failed
                          .map((failure) => `${failure.path} (${failure.error})`)
                          .join('; ')}`,
                }),
              )
              .catch((error: unknown) =>
                toast(error instanceof Error ? error.message : 'That batch could not run.'),
              );
          });
          return;
        case 'folder-default':
          void vault
            .setFolderDefault(action.folder, action.value)
            .then(() =>
              toast(
                action.value === 'encrypted'
                  ? `New notes in ${action.folder || 'the vault root'} will be encrypted.`
                  : `New notes in ${action.folder || 'the vault root'} will be plain.`,
              ),
            )
            .catch((error: unknown) =>
              toast(error instanceof Error ? error.message : 'Could not save that preference.'),
            );
          return;
        case 'move': {
          const name = action.path.split('/').at(-1) ?? action.path;
          const target = action.folder ? `${action.folder}/${name}` : name;
          if (target === action.path) return;
          void vault
            .rename(action.path, target)
            .then((path) => {
              if (selected === action.path) open(path);
            })
            .catch((error: unknown) =>
              toast(error instanceof Error ? error.message : 'Could not move that note.'),
            );
        }
      }
    },
    [vault, selected, open, toast, withVaultKey],
  );

  const actions = useMemo((): PaletteAction[] => {
    const folderOf = (path: string | null) => (path ? path.split('/').slice(0, -1).join('/') : '');
    return [
      {
        id: 'new',
        label: 'New note',
        hint: 'in the current folder',
        run: () => setDialog({ kind: 'new', folder: folderOf(selected) }),
      },
      { id: 'save', label: 'Sync now', hint: '⌘S', run: () => void vault.flush() },
      {
        id: 'preview',
        label: showPreview ? 'Hide preview' : 'Show preview',
        hint: '⌘P',
        run: () => setShowPreview((on) => !on),
      },
      {
        id: 'live',
        label: livePreview ? 'Turn off live preview' : 'Turn on live preview',
        run: () => setLivePreview((on) => !on),
      },
      {
        id: 'backlinks',
        label: showBacklinks ? 'Hide backlinks' : 'Show backlinks',
        run: () => setShowBacklinks((on) => !on),
      },
      ...(selected
        ? [
            {
              id: 'rename',
              label: 'Rename or move this note',
              run: () => setDialog({ kind: 'rename', path: selected }),
            },
            {
              id: 'delete',
              label: 'Delete this note',
              run: () => setDialog({ kind: 'delete', path: selected }),
            },
            {
              id: 'encrypt',
              label: selected.endsWith('.enc') ? 'Decrypt this note' : 'Encrypt this note',
              run: () => onTreeAction({ kind: 'encrypt', path: selected, on: !selected.endsWith('.enc') }),
            },
          ]
        : []),
      ...(state.hasVaultKeyFile && state.sealed === 'open'
        ? [
            {
              id: 'recovery',
              label: 'Issue a new recovery key',
              hint: 'invalidates the old one',
              run: () => {
                void vault
                  .regenerateRecoveryKey()
                  .then((key) => setDialog({ kind: 'recovery', key }))
                  .catch((error: unknown) =>
                    toast(error instanceof Error ? error.message : 'Could not issue a recovery key.'),
                  );
              },
            },
          ]
        : []),
      { id: 'lock', label: 'Lock the vault', hint: '⌘L', run: onLock },
    ];
  }, [selected, showPreview, livePreview, showBacklinks, state.hasVaultKeyFile, state.sealed, vault, onLock, onTreeAction, toast]);

  // Global shortcuts (spec §8.1). Registered here rather than in the editor so
  // they work with focus anywhere - the tree, the preview, the palette button.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();

      if (key === 'k' || (key === 'f' && event.shiftKey)) {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (key === 'p') {
        event.preventDefault();
        setShowPreview((on) => !on);
      } else if (key === 'l') {
        event.preventDefault();
        onLock();
      } else if (key === 's') {
        event.preventDefault();
        void vault.flush();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onLock, vault]);

  const notes = vault.index().notes();
  const tags = useMemo(() => tagCounts(notes), [notes]);
  const visiblePaths = useMemo(() => {
    if (!tagFilter) return state.paths;
    const matching = new Set(
      notes
        .filter((note) => note.tags.some((tag) => tag.toLowerCase() === tagFilter.toLowerCase()))
        .map((note) => note.path),
    );
    return state.paths.filter((path) => matching.has(path));
  }, [state.paths, notes, tagFilter]);

  const unreadable = selected !== null && state.unreadable.includes(selected);

  /**
   * The path a new note in this folder should get. The folder's encryption
   * default decides the extension, and it applies at creation only - it never
   * touches a note that already exists (spec §9.5).
   */
  function suggestPath(folder: string): string {
    const base = folder ? `${folder}/untitled.md` : 'untitled.md';
    return vault.folderDefault(folder) === 'encrypted' ? `${base}.enc` : base;
  }

  return (
    <>
      <Shell
        pane={pane}
        onPane={setPane}
        showAside={showBacklinks && selected !== null}
        header={
          <>
            <strong class="brand">Topazius</strong>
            <span class="repo">{label}</span>
            <button type="button" class="secondary" onClick={() => setPaletteOpen(true)}>
              Search… <kbd>⌘K</kbd>
            </button>
            <span class="spacer" />
            <span class="shell-status">{state.message}</span>
            <StatusChip
              status={state.status}
              pending={state.pending}
              message={state.message}
              onRetry={() => void vault.retry()}
            />
            <InstallButton />
            {state.sealed === 'locked' && (
              <button type="button" class="secondary" onClick={() => setDialog({ kind: 'unlock-key' })}>
                Unlock encrypted notes
              </button>
            )}
            <button type="button" onClick={onLock}>
              Lock
            </button>
          </>
        }
        sidebar={
          <>
            <div class="sidebar-actions">
              <button
                type="button"
                onClick={() =>
                  setDialog({ kind: 'new', folder: selected?.split('/').slice(0, -1).join('/') ?? '' })
                }
              >
                New note
              </button>
            </div>
            <Tree
              paths={visiblePaths}
              selected={selected}
              dirty={state.dirty}
              folderDefault={(folder) => vault.folderDefault(folder)}
              onSelect={open}
              onAction={onTreeAction}
            />
            <TagBar tags={tags} selected={tagFilter} onSelect={setTagFilter} />
          </>
        }
        main={
          doc === null ? (
            <p class="hint empty">
              {state.loading ? 'Loading…' : 'Select a note, or press ⌘K to search.'}
            </p>
          ) : doc.error ? (
            <div class="panel-inline">
              <p class="alert" role="alert">
                {doc.error}
              </p>
              {unreadable && state.hasVaultKeyFile && (
                <button type="button" onClick={() => setDialog({ kind: 'unlock-key' })}>
                  Unlock encrypted notes
                </button>
              )}
            </div>
          ) : (
            <div class={`panes${showPreview ? ' split' : ''}`} data-mobile={pane}>
              <div class="pane pane-edit">
                <Editor
                  path={doc.path}
                  text={doc.text}
                  insertRef={insertIntoEditor}
                  livePreview={livePreview}
                  onChange={save}
                  onSaveNow={() => void vault.flush()}
                  onFiles={(files) => addFiles(files, doc.path)}
                />
              </div>
              {showPreview && (
                <div class="pane pane-preview">
                  <Preview
                    path={doc.path}
                    text={doc.text}
                    resolveLink={(target) => vault.resolveNoteLink(target)}
                    onOpenNote={open}
                    onCreateNote={(target) =>
                      setDialog({ kind: 'new', folder: '', initial: pathForTarget(target) })
                    }
                    onSelectTag={setTagFilter}
                    loadImage={loadImage}
                  />
                </div>
              )}
            </div>
          )
        }
        aside={selected && <Backlinks backlinks={vault.backlinks(selected)} onOpen={open} />}
      />

      {toasts.length > 0 && (
        <div class="toasts" role="status" aria-live="polite">
          {toasts.map((entry) => (
            <p key={entry.id} class="toast">
              {entry.text}
            </p>
          ))}
        </div>
      )}

      {paletteOpen && (
        <Palette
          search={vault.index()}
          actions={actions}
          onOpenNote={open}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {dialog.kind === 'new' && (
        <Prompt
          title="New note"
          label="Path"
          initial={dialog.initial ?? suggestPath(dialog.folder)}
          confirmLabel="Create"
          hint="Folders are created as you name them: work/2026/standup.md"
          onCancel={() => setDialog({ kind: 'none' })}
          onSubmit={async (value) => {
            const path = await vault.create(value.trim(), '');
            setDialog({ kind: 'none' });
            open(path);
          }}
        />
      )}

      {dialog.kind === 'rename' && (
        <Prompt
          title="Rename or move"
          label="New path"
          initial={dialog.path}
          confirmLabel="Rename"
          hint="Moving a note never changes whether it is encrypted."
          onCancel={() => setDialog({ kind: 'none' })}
          onSubmit={async (value) => {
            const path = await vault.rename(dialog.path, value.trim());
            setDialog({ kind: 'none' });
            if (selected === dialog.path) open(path);
          }}
        />
      )}

      {dialog.kind === 'delete' && (
        <Confirm
          title="Delete this note?"
          body={`"${dialog.path}" will be removed from the repository. Git keeps its history, so it can be recovered there.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={async () => {
            await vault.remove(dialog.path);
            setDialog({ kind: 'none' });
            if (selected === dialog.path) {
              setSelected(null);
              setDoc(null);
            }
          }}
        />
      )}

      {dialog.kind === 'encrypt-setup' && (
        <SetupEncryption
          onCreate={(passphrase) => vault.createVaultKey(passphrase)}
          onCancel={() => setDialog({ kind: 'none' })}
          onDone={() => {
            const next = dialog.then;
            setDialog({ kind: 'none' });
            next();
          }}
        />
      )}

      {dialog.kind === 'unlock-key' && (
        <UnlockVaultKey
          onUnlock={(secret, which) => vault.unlockVaultKey(secret, which)}
          onClose={() => {
            setDialog({ kind: 'none' });
            if (selected) open(selected);
          }}
        />
      )}

      {dialog.kind === 'recovery' && (
        <RecoveryKeyShown recoveryKey={dialog.key} onClose={() => setDialog({ kind: 'none' })} />
      )}

      {dialog.kind === 'batch' && (
        <Confirm
          title={dialog.title}
          body={dialog.body}
          confirmLabel="Done"
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => setDialog({ kind: 'none' })}
        />
      )}

      {dialog.kind === 'conflict' && (
        <ConflictDialog
          conflict={dialog.conflict}
          onResolve={async (choice) => {
            await vault.resolveConflict(dialog.conflict.path, choice);
            handled.current.delete(dialog.conflict.path);
            if (selected === dialog.conflict.path) open(dialog.conflict.path);
          }}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}
    </>
  );
}

/** Exported for the "create this missing note" path: `[[some idea]]` → `some-idea.md`. */
export function pathForTarget(target: string): string {
  return target.includes('/')
    ? `${target.split('/').slice(0, -1).join('/')}/${slugify(target.split('/').at(-1) ?? target)}.md`
    : `${slugify(target)}.md`;
}
