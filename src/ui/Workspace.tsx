import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { Conflict } from '../lib/conflict';
import { tagCounts } from '../lib/tags';
import type { Vault } from '../lib/vault';
import { ConflictDialog } from './ConflictDialog';
import { Editor, type EditorControls } from './Editor';
import { RecoveryKeyShown, SetupEncryption, UnlockVaultKey } from './Encryption';
import { InstallButton } from './Install';
import { NewNoteDialog, RenameNoteDialog } from './NoteDialogs';
import { NoteHeader, type SaveState, type ViewMode } from './NoteHeader';
import { Palette, type PaletteAction } from './Palette';
import { Backlinks, StatusChip, TagBar } from './Panels';
import { Preview } from './Preview';
import { Confirm } from './Prompt';
import { Shell, type Pane } from './Shell';
import { Toolbar } from './Toolbar';
import { Tree, type TreeAction } from './Tree';
import { PlusIcon, SearchIcon, SidebarIcon } from './icons';
import './workspace.css';

export interface WorkspaceProps {
  vault: Vault;
  onLock: () => void;
  /** Which repository this vault points at, for the header and the GitHub links. */
  repo: { owner: string; repo: string; branch: string };
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'new'; folder: string; title?: string; encrypted?: boolean }
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
export function Workspace({ vault, onLock, repo }: WorkspaceProps) {
  // A render counter: the vault holds the state, this only asks Preact to
  // look at it again.
  const [, bump] = useReducer((count: number, _: unknown): number => count + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [pane, setPane] = useState<Pane>('files');
  const [view, setView] = useState<ViewMode>('split');
  const [livePreview, setLivePreview] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showBacklinks, setShowBacklinks] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const toastId = useRef(0);
  const handled = useRef(new Set<string>());
  const editor = useRef<EditorControls | null>(null);

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

  // The window title names the note, so a browser tab or an installed window
  // is identifiable among a dozen others.
  useEffect(() => {
    const note = selected ? vault.note(selected) : undefined;
    document.title = note ? `${note.title} — Topazius` : 'Topazius';
  }, [selected, vault, state.paths]);

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

            const controls = editor.current;
            if (controls) {
              // Into the live document, at the cursor (spec §8.3). The editor's
              // own change path saves it, so nothing here can overwrite an edit
              // still sitting inside the save debounce.
              controls.insert(prepared.markdown);
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

  const setEncrypted = useCallback(
    (path: string, on: boolean) => {
      withVaultKey(() => {
        void vault
          .setEncrypted(path, on)
          .then((next) => {
            if (selected === path) open(next);
            toast(on ? 'Note encrypted.' : 'Note decrypted.');
          })
          .catch((error: unknown) =>
            toast(error instanceof Error ? error.message : 'Could not change that note.'),
          );
      });
    },
    [vault, selected, open, toast, withVaultKey],
  );

  const newNoteIn = useCallback(
    (folder: string, title?: string) =>
      setDialog({
        kind: 'new',
        folder,
        ...(title ? { title } : {}),
        encrypted: vault.folderDefault(folder) === 'encrypted',
      }),
    [vault],
  );

  const onTreeAction = useCallback(
    (action: TreeAction) => {
      switch (action.kind) {
        case 'new':
          newNoteIn(action.folder);
          return;
        case 'rename':
          setDialog({ kind: 'rename', path: action.path });
          return;
        case 'delete':
          setDialog({ kind: 'delete', path: action.path });
          return;
        case 'encrypt':
          setEncrypted(action.path, action.on);
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
    [vault, selected, open, toast, withVaultKey, setEncrypted, newNoteIn],
  );

  const folderOf = (path: string | null) => (path ? path.split('/').slice(0, -1).join('/') : '');

  const actions = useMemo((): PaletteAction[] => {
    return [
      {
        id: 'new',
        label: 'New note',
        hint: '⌘N',
        run: () => newNoteIn(folderOf(selected)),
      },
      { id: 'save', label: 'Sync now', hint: '⌘S', run: () => void vault.flush() },
      {
        id: 'view',
        label: view === 'split' ? 'Editor only' : 'Editor and preview',
        hint: '⌘P',
        run: () => setView(view === 'split' ? 'edit' : 'split'),
      },
      {
        id: 'live',
        label: livePreview ? 'Turn off styled markdown' : 'Turn on styled markdown',
        run: () => setLivePreview((on) => !on),
      },
      {
        id: 'sidebar',
        label: showSidebar ? 'Hide the note list' : 'Show the note list',
        run: () => setShowSidebar((on) => !on),
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
              run: () => setEncrypted(selected, !selected.endsWith('.enc')),
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
  }, [
    selected,
    view,
    livePreview,
    showSidebar,
    showBacklinks,
    state.hasVaultKeyFile,
    state.sealed,
    vault,
    onLock,
    toast,
    setEncrypted,
    newNoteIn,
  ]);

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
        setView((current) => (current === 'split' ? 'edit' : 'split'));
      } else if (key === 'n') {
        event.preventDefault();
        newNoteIn(folderOf(selected));
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
  }, [onLock, vault, selected, newNoteIn]);

  const notes = vault.index().notes();
  const tags = useMemo(() => tagCounts(notes), [notes]);
  const visiblePaths = useMemo(() => {
    let paths = state.paths;
    if (folderFilter) {
      paths = paths.filter((path) => path.startsWith(`${folderFilter}/`));
    }
    if (tagFilter) {
      const matching = new Set(
        notes
          .filter((note) => note.tags.some((tag) => tag.toLowerCase() === tagFilter.toLowerCase()))
          .map((note) => note.path),
      );
      paths = paths.filter((path) => matching.has(path));
    }
    return paths;
  }, [state.paths, notes, tagFilter, folderFilter]);

  const unreadable = selected !== null && state.unreadable.includes(selected);

  /** What the note header's badge says about this note's journey to GitHub. */
  function saveStateFor(path: string): SaveState {
    if (state.conflicts.includes(path)) return 'conflict';
    if (!state.dirty.includes(path)) return 'saved';
    if (state.status === 'offline' || state.status === 'paused') return 'offline';
    if (state.status === 'error') return 'error';
    return state.status === 'saving' ? 'saving' : 'unsaved';
  }

  /** The note on GitHub. Null until it has actually been pushed there. */
  function linksFor(path: string): { file: string; history: string } | null {
    if (state.dirty.includes(path) && !state.paths.includes(path)) return null;
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const base = `https://github.com/${repo.owner}/${repo.repo}`;
    return {
      file: `${base}/blob/${encodeURIComponent(repo.branch)}/${encoded}`,
      history: `${base}/commits/${encodeURIComponent(repo.branch)}/${encoded}`,
    };
  }

  return (
    <>
      <Shell
        pane={pane}
        onPane={setPane}
        showSidebar={showSidebar}
        showAside={showBacklinks && selected !== null}
        header={
          <>
            <button
              type="button"
              class="icon-button"
              aria-label={showSidebar ? 'Hide the note list' : 'Show the note list'}
              aria-pressed={showSidebar}
              title={showSidebar ? 'Hide the note list' : 'Show the note list'}
              onClick={() => setShowSidebar((on) => !on)}
            >
              <SidebarIcon />
            </button>
            <strong class="brand">Topazius</strong>
            <span class="repo">{`${repo.owner}/${repo.repo}`}</span>

            <button type="button" class="search-button" onClick={() => setPaletteOpen(true)}>
              <SearchIcon />
              <span>Search notes</span>
              <kbd>⌘K</kbd>
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
              <button type="button" class="primary" onClick={() => newNoteIn(folderFilter ?? folderOf(selected))}>
                <PlusIcon />
                New note
                <kbd>⌘N</kbd>
              </button>
            </div>
            {folderFilter && (
              <button type="button" class="filter-chip" onClick={() => setFolderFilter(null)}>
                In <strong>{folderFilter}</strong> — show everything
              </button>
            )}
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
            <div class="empty">
              {state.loading ? (
                <p class="hint">Loading your notes…</p>
              ) : (
                <>
                  <h2>{state.paths.length === 0 ? 'This vault is empty' : 'No note open'}</h2>
                  <p class="hint">
                    {state.paths.length === 0
                      ? 'Write the first one — it becomes a markdown file in your repository.'
                      : 'Pick one from the list, or search the whole vault.'}
                  </p>
                  <div class="empty-actions">
                    <button type="button" onClick={() => newNoteIn(folderOf(selected))}>
                      New note
                    </button>
                    {state.paths.length > 0 && (
                      <button type="button" class="secondary" onClick={() => setPaletteOpen(true)}>
                        Search… <kbd>⌘K</kbd>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
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
            <div class="note">
              <NoteHeader
                path={doc.path}
                title={vault.note(doc.path)?.title ?? doc.path.split('/').at(-1) ?? doc.path}
                encrypted={doc.path.endsWith('.enc')}
                save={saveStateFor(doc.path)}
                view={view}
                onView={setView}
                onOpenFolder={(folder) => {
                  setTagFilter(null);
                  setFolderFilter(folder);
                  setPane('files');
                }}
                onRename={() => setDialog({ kind: 'rename', path: doc.path })}
                onDelete={() => setDialog({ kind: 'delete', path: doc.path })}
                onToggleEncryption={() => setEncrypted(doc.path, !doc.path.endsWith('.enc'))}
                links={linksFor(doc.path)}
              />

              {view !== 'preview' && (
                <Toolbar
                  run={(action) => editor.current?.run(action)}
                  onPickImage={(files) => addFiles(files, doc.path)}
                />
              )}

              <div class={`panes${view === 'split' ? ' split' : ''}`} data-mobile={pane}>
                {view !== 'preview' && (
                  <div class="pane pane-edit">
                    <Editor
                      path={doc.path}
                      text={doc.text}
                      controls={editor}
                      livePreview={livePreview}
                      onChange={save}
                      onSaveNow={() => void vault.flush()}
                      onFiles={(files) => addFiles(files, doc.path)}
                    />
                  </div>
                )}
                {view !== 'edit' && (
                  <div class="pane pane-preview">
                    <Preview
                      path={doc.path}
                      text={doc.text}
                      resolveLink={(target) => vault.resolveNoteLink(target)}
                      onOpenNote={open}
                      onCreateNote={(target) => newNoteIn(folderOf(doc.path), target)}
                      onSelectTag={setTagFilter}
                      loadImage={loadImage}
                    />
                  </div>
                )}
              </div>
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
        <NewNoteDialog
          paths={state.paths}
          folder={dialog.folder}
          {...(dialog.title ? { title: dialog.title } : {})}
          canEncrypt={state.sealed === 'open'}
          encrypted={dialog.encrypted === true && state.sealed === 'open'}
          onCancel={() => setDialog({ kind: 'none' })}
          onSubmit={async (path) => {
            const created = await vault.create(path, '');
            setDialog({ kind: 'none' });
            open(created);
          }}
        />
      )}

      {dialog.kind === 'rename' && (
        <RenameNoteDialog
          path={dialog.path}
          paths={state.paths}
          onCancel={() => setDialog({ kind: 'none' })}
          onSubmit={async (path) => {
            const moved = await vault.rename(dialog.path, path);
            setDialog({ kind: 'none' });
            if (selected === dialog.path) open(moved);
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
