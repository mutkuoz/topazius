/**
 * @vitest-environment jsdom
 *
 * jsdom rather than happy-dom, for two reasons: the preview pane's output goes
 * through DOMPurify, which happy-dom's `nodeName` handling defeats (see
 * markdown.test.ts), and CodeMirror wants a DOM complete enough to measure.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conflict, ResolutionChoice } from '../src/lib/conflict';
import { type IndexedNote, createSearch, indexNote } from '../src/lib/search';
import type { Vault, VaultState } from '../src/lib/vault';
import { Workspace } from '../src/ui/Workspace';

afterEach(cleanup);

interface FakeOptions {
  notes?: Record<string, string>;
  state?: Partial<VaultState>;
  conflict?: Conflict;
}

/**
 * A Vault double. The real one has its own integration suite (vault.test.ts);
 * what these tests are about is what the UI does with it.
 */
function fakeVault(options: FakeOptions = {}) {
  const notes = new Map(Object.entries(options.notes ?? {}));
  const search = createSearch([...notes].map(([path, source]) => indexNote(path, source)));
  const listeners = new Set<() => void>();
  const calls = {
    save: [] as Array<[string, string]>,
    create: [] as string[],
    remove: [] as string[],
    rename: [] as Array<[string, string]>,
    setEncrypted: [] as Array<[string, boolean]>,
    resolved: [] as ResolutionChoice[],
    flushed: 0,
  };

  const state: VaultState = {
    loading: false,
    message: `${notes.size} notes`,
    status: 'synced',
    pending: 0,
    paths: [...notes.keys()],
    assets: [],
    dirty: [],
    conflicts: [],
    failures: [],
    unreadable: [],
    sealed: 'none',
    hasVaultKeyFile: false,
    ...options.state,
  };

  const vault: Vault = {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: () => Promise.resolve(),
    index: () => search,
    note: (path) => search.get(path),
    backlinks: () => [],
    missingLinks: () => new Map(),
    resolveNoteLink: (target) =>
      [...notes.keys()].find((path) => path.replace(/\.md(\.enc)?$/, '') === target) ?? null,
    read: (path) => {
      const source = notes.get(path);
      return source === undefined
        ? Promise.reject(new Error(`Note "${path}" is not cached.`))
        : Promise.resolve(source);
    },
    save: (path, text) => {
      calls.save.push([path, text]);
      notes.set(path, text);
      return Promise.resolve();
    },
    create: (path) => {
      calls.create.push(path);
      notes.set(path, '');
      state.paths = [...notes.keys()];
      return Promise.resolve(path);
    },
    remove: (path) => {
      calls.remove.push(path);
      notes.delete(path);
      state.paths = [...notes.keys()];
      return Promise.resolve();
    },
    rename: (from, to) => {
      calls.rename.push([from, to]);
      notes.set(to, notes.get(from) ?? '');
      notes.delete(from);
      state.paths = [...notes.keys()];
      return Promise.resolve(to);
    },
    setEncrypted: (path, on) => {
      calls.setEncrypted.push([path, on]);
      return Promise.resolve(on ? `${path}.enc` : path.replace(/\.enc$/, ''));
    },
    encryptFolder: () => Promise.resolve({ done: [], failed: [] }),
    folderDefault: () => 'plain',
    setFolderDefault: () => Promise.resolve(),
    addImage: () =>
      Promise.resolve({
        path: 'assets/2026/08/x-1234abcd.png',
        bytes: new Uint8Array() as Uint8Array<ArrayBuffer>,
        mime: 'image/png',
        markdown: '![x](assets/2026/08/x-1234abcd.png)',
      }),
    assetBytes: () => Promise.resolve(null),
    flush: () => {
      calls.flushed++;
      return Promise.resolve();
    },
    retry: () => Promise.resolve(),
    conflictFor: () =>
      options.conflict
        ? Promise.resolve(options.conflict)
        : Promise.reject(new Error('no conflict staged')),
    resolveConflict: (_path, choice) => {
      calls.resolved.push(choice);
      return Promise.resolve();
    },
    createVaultKey: () => Promise.resolve('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23'),
    unlockVaultKey: () => Promise.resolve(),
    regenerateRecoveryKey: () => Promise.resolve('0000-1111-2222-3333-4444-5555-66'),
    keyFile: () => null,
    dispose: () => undefined,
  };

  return { vault, calls, state, notes, notify: () => listeners.forEach((listener) => listener()) };
}

function renderWorkspace(options: FakeOptions = {}) {
  const fake = fakeVault(options);
  const onLock = vi.fn();
  render(<Workspace vault={fake.vault} onLock={onLock} label="me/my-notes" />);
  return { ...fake, onLock, user: userEvent.setup() };
}

const NOTES = {
  'work/standup.md': '# Monday\n\nshipped the parser. see [[work/roadmap]] and #planning\n',
  'work/roadmap.md': '# Roadmap\n\nship the editor\n',
};

describe('opening notes', () => {
  it('lists the vault and opens a note when its row is clicked', async () => {
    const { user } = renderWorkspace({ notes: NOTES });

    await user.click(screen.getByRole('button', { name: /standup/ }));

    const preview = await previewPane();
    expect(within(preview).getByText(/shipped the parser/)).toBeInTheDocument();
  });

  it('says what went wrong when a note cannot be opened', async () => {
    const { user } = renderWorkspace({
      notes: NOTES,
      state: { paths: [...Object.keys(NOTES), 'journal/sealed.md.enc'], unreadable: ['journal/sealed.md.enc'] },
    });

    await user.click(screen.getByRole('button', { name: /sealed/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not cached/i);
  });

  it('shows the repository and the sync status in the header', () => {
    renderWorkspace({ notes: NOTES });
    expect(screen.getByText('me/my-notes')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Synced');
    expect(screen.getByText('2 notes')).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('writes edits back to the vault', async () => {
    const { user, calls } = renderWorkspace({ notes: NOTES });
    await user.click(screen.getByRole('button', { name: /standup/ }));
    await previewPane();

    const line = document.querySelector('.cm-content');
    expect(line).not.toBeNull();
    await user.click(line as Element);
    await user.keyboard('!');

    // The editor debounces before it saves, so the assertion waits for it.
    await waitFor(() => expect(calls.save.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(calls.save.at(-1)?.[0]).toBe('work/standup.md');
  });
});

describe('preview', () => {
  it('renders the note and follows a wikilink', async () => {
    const { user } = renderWorkspace({ notes: NOTES });
    await user.click(screen.getByRole('button', { name: /standup/ }));

    const preview = await previewPane();
    await user.click(within(preview).getByText('work/roadmap'));

    await waitFor(() =>
      expect(within(document.querySelector('.preview') as HTMLElement).getByText(/ship the editor/)).toBeInTheDocument(),
    );
  });

  it('filters the tree when a tag is clicked in the preview', async () => {
    const { user } = renderWorkspace({ notes: NOTES });
    await user.click(screen.getByRole('button', { name: /standup/ }));

    const preview = await previewPane();
    await user.click(within(preview).getByText('#planning'));

    await waitFor(() => expect(screen.queryByRole('button', { name: /roadmap/ })).toBeNull());
    expect(screen.getByRole('button', { name: /standup/ })).toBeInTheDocument();
  });
});

describe('the command palette', () => {
  it('opens with ⌘K and quick-opens a note', async () => {
    const { user } = renderWorkspace({ notes: NOTES });

    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByRole('dialog', { name: /command palette/i });

    await user.type(within(palette).getByRole('textbox'), 'roadmap');
    await user.keyboard('{Enter}');

    const preview = await previewPane();
    expect(within(preview).getByText(/ship the editor/)).toBeInTheDocument();
  });

  it('finds a note by its body text', async () => {
    const { user } = renderWorkspace({ notes: NOTES });

    await user.click(screen.getByRole('button', { name: /search/i }));
    const palette = await screen.findByRole('dialog', { name: /command palette/i });
    await user.type(within(palette).getByRole('textbox'), 'parser');

    // Quick-open matches paths as a subsequence and "parser" is not one, so
    // this result can only have come from the full-text index.
    const option = await within(palette).findByRole('option');
    expect(option).toHaveTextContent('Monday');
    expect(option).toHaveTextContent(/shipped the parser/);
  });

  it('runs a command typed after >', async () => {
    const { user, calls } = renderWorkspace({ notes: NOTES });

    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByRole('dialog', { name: /command palette/i });
    await user.type(within(palette).getByRole('textbox'), '>sync');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(calls.flushed).toBeGreaterThan(0));
  });

  it('lists every sealed note under enc:', async () => {
    const { user } = renderWorkspace({
      notes: { ...NOTES, 'journal/aug.md.enc': '# August' },
    });

    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByRole('dialog', { name: /command palette/i });
    await user.type(within(palette).getByRole('textbox'), 'enc:');

    const options = within(palette).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('journal/aug.md.enc');
  });

  it('closes on Escape', async () => {
    const { user } = renderWorkspace({ notes: NOTES });
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('dialog', { name: /command palette/i });
    // The palette focuses its input from an effect; findByRole can resolve
    // before Preact has flushed it, and a keystroke dispatched in that gap
    // lands on <body> instead. Wait for the caret to arrive first.
    await waitFor(() => expect(document.activeElement).toHaveClass('palette-input'));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the note lifecycle', () => {
  it('creates a note from the sidebar', async () => {
    const { user, calls } = renderWorkspace({ notes: NOTES });

    await user.click(screen.getByRole('button', { name: /new note/i }));
    const dialog = await screen.findByRole('dialog', { name: /new note/i });
    const input = within(dialog).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'inbox/idea.md');
    await user.click(within(dialog).getByRole('button', { name: /create/i }));

    await waitFor(() => expect(calls.create).toEqual(['inbox/idea.md']));
  });

  it('asks before deleting, and deletes on confirmation', async () => {
    const { user, calls } = renderWorkspace({ notes: NOTES });

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /standup/ }) });
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

    const dialog = await screen.findByRole('dialog', { name: /delete this note/i });
    expect(dialog).toHaveTextContent(/git keeps its history/i);

    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(calls.remove).toEqual(['work/standup.md']));
  });

  it('renames through the context menu', async () => {
    const { user, calls } = renderWorkspace({ notes: NOTES });

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /standup/ }) });
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }));

    const dialog = await screen.findByRole('dialog', { name: /rename or move/i });
    const input = within(dialog).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'archive/standup.md');
    await user.click(within(dialog).getByRole('button', { name: /rename/i }));

    await waitFor(() => expect(calls.rename).toEqual([['work/standup.md', 'archive/standup.md']]));
  });
});

describe('encryption', () => {
  it('runs the recovery-key ceremony before the first note is sealed', async () => {
    const { user, calls } = renderWorkspace({ notes: NOTES });

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /standup/ }) });
    await user.click(await screen.findByRole('menuitem', { name: /encrypt this note/i }));

    const dialog = await screen.findByRole('dialog', { name: /encrypt this note/i });
    // The leakage table is shown before anything is encrypted (spec §9.6).
    expect(dialog).toHaveTextContent(/file and folder names/i);

    await user.type(within(dialog).getByLabelText(/passphrase/i), 'a good long passphrase');
    await user.click(within(dialog).getByRole('button', { name: /set up encryption/i }));

    const ceremony = await screen.findByRole('dialog', { name: /save your recovery key/i });
    expect(ceremony).toHaveTextContent('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23');

    // Cannot continue until the user says they stored it (spec §9.3).
    const done = within(ceremony).getByRole('button', { name: /continue/i });
    expect(done).toBeDisabled();
    await user.click(within(ceremony).getByRole('checkbox'));
    await user.click(done);

    await waitFor(() => expect(calls.setEncrypted).toEqual([['work/standup.md', true]]));
  });

  it('offers to unlock a vault whose sealed notes it has no key for', async () => {
    renderWorkspace({
      notes: NOTES,
      state: { sealed: 'locked', hasVaultKeyFile: true },
    });

    expect(screen.getByRole('button', { name: /unlock encrypted notes/i })).toBeInTheDocument();
  });
});

describe('conflicts', () => {
  const conflict: Conflict = {
    path: 'work/standup.md',
    local: '# Monday\n\nmine\n',
    remote: '# Monday\n\ntheirs\n',
    remoteSha: 'remote-sha',
    remoteMissing: false,
  };

  it('opens a modal showing both sides, and resolves on a choice', async () => {
    const { user, calls } = renderWorkspace({
      notes: NOTES,
      conflict,
      state: { conflicts: ['work/standup.md'], status: 'conflict' },
    });

    const dialog = await screen.findByRole('dialog', { name: /changed on GitHub/i });
    expect(within(dialog).getByText('theirs')).toBeInTheDocument();
    expect(within(dialog).getByText('mine')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /keep mine/i }));

    await waitFor(() => expect(calls.resolved).toEqual([{ kind: 'mine' }]));
  });

  it('offers a hand merge that uploads the edited text', async () => {
    const { user, calls } = renderWorkspace({
      notes: NOTES,
      conflict,
      state: { conflicts: ['work/standup.md'], status: 'conflict' },
    });

    const dialog = await screen.findByRole('dialog', { name: /changed on GitHub/i });
    await user.click(within(dialog).getByRole('button', { name: /merge by hand/i }));
    await user.click(within(dialog).getByRole('button', { name: /save merged/i }));

    expect(calls.resolved[0]).toMatchObject({ kind: 'merged' });
  });
});

describe('status', () => {
  it('offers a retry when the queue is offline', () => {
    renderWorkspace({
      notes: NOTES,
      state: { status: 'offline', pending: 2, message: 'Offline — changes are queued.' },
    });

    expect(screen.getByRole('status')).toHaveTextContent('Offline — 2 pending');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('marks notes with unsynced edits in the tree', () => {
    renderWorkspace({ notes: NOTES, state: { dirty: ['work/standup.md'] } });
    const row = screen.getByRole('button', { name: /standup/ });
    expect(within(row).getByLabelText('unsaved')).toBeInTheDocument();
  });
});

describe('shortcuts', () => {
  it('⌘S flushes the queue and ⌘L locks', async () => {
    const { user, calls, onLock } = renderWorkspace({ notes: NOTES });

    await user.keyboard('{Meta>}s{/Meta}');
    expect(calls.flushed).toBe(1);

    await user.keyboard('{Meta>}l{/Meta}');
    expect(onLock).toHaveBeenCalled();
  });

  it('⌘P hides and shows the preview', async () => {
    const { user } = renderWorkspace({ notes: NOTES });
    await user.click(screen.getByRole('button', { name: /standup/ }));
    await waitFor(() => expect(document.querySelector('.preview')).not.toBeNull());

    await user.keyboard('{Meta>}p{/Meta}');
    await waitFor(() => expect(document.querySelector('.preview')).toBeNull());
  });
});

/** Wait for the preview pane to have rendered something. */
async function previewPane(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector('.preview');
    if (!element || element.childNodes.length === 0) throw new Error('preview is still empty');
    return element as HTMLElement;
  });
}

/** The index the palette searches is the vault's, not a copy. */
describe('index wiring', () => {
  it('reflects notes added after the first render', async () => {
    const { user, vault, notify } = renderWorkspace({ notes: NOTES });
    vault.index().update(indexNote('inbox/new.md', '# New\n\nteleportation') as IndexedNote);
    notify();

    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByRole('dialog', { name: /command palette/i });
    await user.type(within(palette).getByRole('textbox'), 'teleportation');

    expect(await within(palette).findByText('New')).toBeInTheDocument();
  });
});
