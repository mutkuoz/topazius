import type { IDBPDatabase } from 'idb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SALT_BYTES, deriveKey, randomBytes } from '../src/lib/crypto';
import { type AppConfig, type TopaziusDB, destroyVaultDB, openVaultDB, readAsset, readNote } from '../src/lib/db';
import { GitHubError, type GitHubClient, type TreeEntry } from '../src/lib/github';
import { isSealed } from '../src/lib/noteenc';
import type { Session } from '../src/lib/session';
import { createVault } from '../src/lib/vault';
import { VAULT_KEY_PATH, createVaultKey } from '../src/lib/vaultkey';
import { stubClient } from './helpers';

const CONFIG: AppConfig = { owner: 'me', repo: 'my-notes', branch: 'main', prefs: {} };
const utf8 = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * A GitHub repository, in memory: shas, optimistic concurrency, and 404s
 * behave the way the Contents API does, so the vault is exercised end to end
 * without pretending the network is a mock function call.
 */
function fakeRemote(initial: Record<string, string> = {}) {
  const files = new Map<string, { sha: string; bytes: Uint8Array }>();
  let counter = 0;
  const nextSha = () => `sha-${++counter}`;

  for (const [path, body] of Object.entries(initial)) {
    files.set(path, { sha: nextSha(), bytes: utf8.encode(body) });
  }

  const client: GitHubClient = stubClient({
    getTree: () =>
      Promise.resolve(
        [...files].map(([path, file]): TreeEntry => ({ path, sha: file.sha, size: file.bytes.length })),
      ),
    getBlob: (sha) => {
      const found = [...files.values()].find((file) => file.sha === sha);
      if (!found) return Promise.reject(new GitHubError(404, 'Not Found'));
      return Promise.resolve(found.bytes as Uint8Array<ArrayBuffer>);
    },
    getFile: (path) => {
      const found = files.get(path);
      return Promise.resolve(
        found ? { sha: found.sha, bytes: found.bytes as Uint8Array<ArrayBuffer> } : null,
      );
    },
    putFile: ({ path, bytes, sha }) => {
      const current = files.get(path);
      if (current && current.sha !== sha) {
        return Promise.reject(new GitHubError(409, `${path} does not match ${String(sha)}`));
      }
      if (!current && sha) {
        return Promise.reject(new GitHubError(409, `${path} does not exist`));
      }
      const fresh = nextSha();
      files.set(path, { sha: fresh, bytes: new Uint8Array(bytes) });
      return Promise.resolve({ sha: fresh, size: bytes.length });
    },
    deleteFile: ({ path }) => {
      files.delete(path);
      return Promise.resolve();
    },
  });

  return {
    client,
    files,
    read: (path: string) => {
      const file = files.get(path);
      return file ? text(file.bytes) : null;
    },
    write: (path: string, body: string) => {
      files.set(path, { sha: nextSha(), bytes: utf8.encode(body) });
    },
  };
}

let sessionKey: CryptoKey;

beforeAll(async () => {
  // Derived once: this suite is about the vault, and session.test.ts already
  // covers what happens around the key.
  sessionKey = await deriveKey('a passphrase for tests', randomBytes(SALT_BYTES));
});

function fakeSession(overrides: Partial<Session> = {}): Session {
  let vmk: CryptoKey | null = null;
  return {
    state: () => 'unlocked',
    enroll: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(),
    getToken: () => 'token',
    getKey: () => sessionKey,
    getVaultKey: () => vmk,
    verifyPassphrase: () => Promise.resolve(true),
    createVaultKey: async (passphrase: string) => {
      const created = await createVaultKey(passphrase);
      vmk = created.vmk;
      return { file: created.file, recoveryKey: created.recoveryKey };
    },
    openVaultKey: vi.fn(),
    regenerateRecoveryKey: vi.fn(),
    touch: vi.fn(),
    onChange: () => () => {},
    logout: vi.fn(),
    ...overrides,
  };
}

let db: IDBPDatabase<TopaziusDB>;
const open: Array<{ dispose: () => void }> = [];

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  // Dispose first: a vault left holding its commit timer would fire a flush
  // against a database this hook is about to delete.
  for (const vault of open.splice(0)) vault.dispose();
  db.close();
  await destroyVaultDB();
});

interface HarnessOptions {
  remote?: ReturnType<typeof fakeRemote>;
  session?: Session;
  config?: Partial<AppConfig>;
}

function harness(options: HarnessOptions = {}) {
  const remote = options.remote ?? fakeRemote();
  const session = options.session ?? fakeSession();
  const vault = createVault({
    db,
    session,
    config: { ...CONFIG, ...options.config },
    gh: remote.client,
    // Long enough never to fire: these tests flush explicitly, so what
    // reaches the remote is what the code under test decided to send, not
    // what a timer happened to catch.
    commitDebounceMs: 60_000,
  });
  open.push(vault);
  return { remote, session, vault };
}

describe('load', () => {
  it('lists notes, assets, and reports how many there are', async () => {
    const { vault } = harness({
      remote: fakeRemote({
        'work/standup.md': '# Monday',
        'recipes/pizza.md': '# Pizza',
        'assets/2026/08/pic-a1b2c3d4.png': 'PNGDATA',
      }),
    });

    await vault.load();

    expect(vault.state().paths.sort()).toEqual(['recipes/pizza.md', 'work/standup.md']);
    expect(vault.state().assets).toEqual(['assets/2026/08/pic-a1b2c3d4.png']);
    expect(vault.state().message).toBe('2 notes');
    expect(vault.state().sealed).toBe('none');
  });

  it('keeps the note count current, and yields to what the queue has to say', async () => {
    const { vault } = harness({ remote: fakeRemote({ 'a.md': '# A' }) });
    await vault.load();
    expect(vault.state().message).toBe('1 note');

    await vault.create('b.md', '# B');
    expect(vault.state().message).toBe('2 notes');
  });

  it('reports how many notes did not load', async () => {
    const remote = fakeRemote({ 'a.md': '# A', 'b.md': '# B' });
    const gh: GitHubClient = {
      ...remote.client,
      getBlob: (sha) =>
        sha === 'sha-2' ? Promise.reject(new Error('network hiccup')) : remote.client.getBlob(sha),
    };
    const vault = createVault({ db, session: fakeSession(), config: CONFIG, gh, commitDebounceMs: 60_000 });
    open.push(vault);

    await vault.load();

    expect(vault.state().message).toBe('2 notes (1 did not load)');
    expect(vault.state().failures[0]?.path).toBe('b.md');
  });

  it('builds the search index and the backlink graph', async () => {
    const { vault } = harness({
      remote: fakeRemote({
        'work/standup.md': '# Monday\n\nsee [[work/roadmap]] #planning',
        'work/roadmap.md': '# Roadmap',
      }),
    });

    await vault.load();

    expect(vault.index().search('roadmap')[0]?.path).toBe('work/roadmap.md');
    expect(vault.backlinks('work/roadmap.md')[0]?.from).toBe('work/standup.md');
    expect(vault.note('work/standup.md')?.tags).toEqual(['planning']);
  });

  it('locks the session when GitHub rejects the token', async () => {
    const session = fakeSession();
    const remote = fakeRemote();
    const gh = stubClient({ getTree: () => Promise.reject(new GitHubError(401, 'Bad credentials')) });
    const vault = createVault({ db, session, config: CONFIG, gh, commitDebounceMs: 60_000 });
    open.push(vault);

    await vault.load();

    expect(session.lock).toHaveBeenCalled();
    expect(vault.state().message).toMatch(/rejected your token/);
    expect(remote.files.size).toBe(0);
  });
});

describe('create, save, delete', () => {
  it('creates a note, commits it, and clears dirty', async () => {
    const { vault, remote } = harness();
    await vault.load();

    const path = await vault.create('inbox/idea.md', '# Idea\n');
    expect(path).toBe('inbox/idea.md');
    expect(vault.state().dirty).toEqual(['inbox/idea.md']);

    await vault.flush();

    expect(remote.read('inbox/idea.md')).toBe('# Idea\n');
    expect(vault.state().dirty).toEqual([]);
    expect(vault.state().status).toBe('synced');
  });

  it('refuses a second note at the same path, in either state', async () => {
    const { vault } = harness();
    await vault.load();
    await vault.create('a.md', '');

    await expect(vault.create('a.md')).rejects.toThrow(/already exists/);
    await expect(vault.create('a.md.enc')).rejects.toThrow(/same note/);
  });

  it('refuses a path that escapes the vault or lands in a reserved folder', async () => {
    const { vault } = harness();
    await vault.load();

    await expect(vault.create('../escape.md')).rejects.toThrow(/".." /);
    await expect(vault.create('assets/x.md')).rejects.toThrow(/reserved/);
    await expect(vault.create('notes.txt')).rejects.toThrow(/must end in \.md/);
  });

  it('saves an edit and commits the new content against the sha it was given', async () => {
    const { vault, remote } = harness({ remote: fakeRemote({ 'a.md': '# A\n' }) });
    await vault.load();

    await vault.save('a.md', '# A\n\nmore\n');
    expect(vault.state().dirty).toEqual(['a.md']);
    expect(await vault.read('a.md')).toBe('# A\n\nmore\n');

    await vault.flush();
    expect(remote.read('a.md')).toBe('# A\n\nmore\n');
    expect(vault.state().dirty).toEqual([]);
  });

  it('keeps typing local: a save with no flush touches nothing remote', async () => {
    const { vault, remote } = harness({ remote: fakeRemote({ 'a.md': '# A\n' }) });
    await vault.load();

    await vault.save('a.md', 'edited');

    expect(remote.read('a.md')).toBe('# A\n');
    expect(await vault.read('a.md')).toBe('edited');
  });

  it('deletes a note locally and remotely', async () => {
    const { vault, remote } = harness({ remote: fakeRemote({ 'a.md': '# A\n' }) });
    await vault.load();

    await vault.remove('a.md');
    expect(vault.state().paths).toEqual([]);

    await vault.flush();
    expect(remote.read('a.md')).toBeNull();
  });

  it('deleting a never-synced note sends nothing at all', async () => {
    const { vault, remote } = harness();
    await vault.load();

    await vault.create('draft.md', 'x');
    await vault.remove('draft.md');
    await vault.flush();

    expect(remote.files.size).toBe(0);
  });

  it('updates the search index as notes come and go', async () => {
    const { vault } = harness();
    await vault.load();

    await vault.create('a.md', '# A\n\nsourdough');
    expect(vault.index().search('sourdough')[0]?.path).toBe('a.md');

    await vault.save('a.md', '# A\n\nrye');
    expect(vault.index().search('sourdough')).toEqual([]);
    expect(vault.index().search('rye')[0]?.path).toBe('a.md');

    await vault.remove('a.md');
    expect(vault.index().search('rye')).toEqual([]);
  });
});

describe('rename', () => {
  it('creates the new path before deleting the old one', async () => {
    const order: string[] = [];
    const remote = fakeRemote({ 'work/standup.md': '# Monday\n' });
    const wrapped: GitHubClient = {
      ...remote.client,
      putFile: (input) => {
        order.push(`put ${input.path}`);
        return remote.client.putFile(input);
      },
      deleteFile: (input) => {
        order.push(`delete ${input.path}`);
        return remote.client.deleteFile(input);
      },
    };
    const vault = createVault({
      db,
      session: fakeSession(),
      config: CONFIG,
      gh: wrapped,
      commitDebounceMs: 60_000,
    });
    open.push(vault);

    await vault.load();
    await vault.rename('work/standup.md', 'archive/standup.md');
    await vault.flush();

    expect(order).toEqual(['put archive/standup.md', 'delete work/standup.md']);
    expect(remote.read('archive/standup.md')).toBe('# Monday\n');
    expect(remote.read('work/standup.md')).toBeNull();
  });

  it('rewrites inbound wikilinks in the same batch', async () => {
    const remote = fakeRemote({
      'work/standup.md': '# Monday\n',
      'work/roadmap.md': 'see [[work/standup]] for context\n',
      'unrelated.md': 'nothing to do with it\n',
    });
    const { vault } = harness({ remote });

    await vault.load();
    await vault.rename('work/standup.md', 'archive/standup.md');
    await vault.flush();

    expect(remote.read('work/roadmap.md')).toBe('see [[archive/standup]] for context\n');
    expect(remote.read('unrelated.md')).toBe('nothing to do with it\n');
  });

  it('refuses to rename onto an existing note', async () => {
    const { vault } = harness({ remote: fakeRemote({ 'a.md': 'A', 'b.md': 'B' }) });
    await vault.load();
    await expect(vault.rename('a.md', 'b.md')).rejects.toThrow(/already exists/);
  });
});

describe('encryption', () => {
  async function sealedHarness() {
    const remote = fakeRemote({ 'journal/aug.md': '# August\n\nprivate thoughts\n' });
    const { vault, session } = harness({ remote });
    await vault.load();
    const recoveryKey = await vault.createVaultKey('correct horse battery staple');
    return { remote, vault, session, recoveryKey };
  }

  it('creates the vault key, shows a recovery key once, and commits the wrapped file', async () => {
    const { vault, remote, recoveryKey } = await sealedHarness();
    await vault.flush();

    expect(recoveryKey.replace(/-/g, '')).toHaveLength(26);
    const committed = remote.read(VAULT_KEY_PATH);
    expect(committed).toContain('"passphrase"');
    expect(committed).toContain('"recovery"');
    expect(vault.state().hasVaultKeyFile).toBe(true);
  });

  it('seals a note on toggle and stores only ciphertext remotely', async () => {
    const { vault, remote } = await sealedHarness();

    const sealedPath = await vault.setEncrypted('journal/aug.md', true);
    await vault.flush();

    expect(sealedPath).toBe('journal/aug.md.enc');
    const stored = remote.read('journal/aug.md.enc') ?? '';
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain('private thoughts');
    expect(remote.read('journal/aug.md')).toBeNull();
  });

  it('reads a sealed note back as the user wrote it', async () => {
    const { vault } = await sealedHarness();
    await vault.setEncrypted('journal/aug.md', true);
    expect(await vault.read('journal/aug.md.enc')).toBe('# August\n\nprivate thoughts\n');
  });

  it('keeps sealed notes searchable, because they are decrypted in memory', async () => {
    const { vault } = await sealedHarness();
    await vault.setEncrypted('journal/aug.md', true);
    expect(vault.index().search('private')[0]?.path).toBe('journal/aug.md.enc');
  });

  it('caches the sealed form on disk, never the plaintext', async () => {
    const { vault } = await sealedHarness();
    await vault.setEncrypted('journal/aug.md', true);

    const record = await readNote(db, 'journal/aug.md.enc');
    expect(record).toBeDefined();
    // Encrypted under the session key on top of being sealed: the cache is
    // ciphertext twice over.
    expect(text(record?.enc.ct ?? new Uint8Array())).not.toContain('private');
  });

  it('unseals on toggle back, restoring an ordinary markdown file', async () => {
    const { vault, remote } = await sealedHarness();
    await vault.setEncrypted('journal/aug.md', true);
    await vault.flush();

    await vault.setEncrypted('journal/aug.md.enc', false);
    await vault.flush();

    expect(remote.read('journal/aug.md')).toBe('# August\n\nprivate thoughts\n');
    expect(remote.read('journal/aug.md.enc')).toBeNull();
  });

  it('re-seals under the new path when a sealed note is renamed', async () => {
    const { vault, remote } = await sealedHarness();
    await vault.setEncrypted('journal/aug.md', true);
    await vault.flush();

    await vault.rename('journal/aug.md.enc', 'journal/august.md.enc');
    await vault.flush();

    // Proof that it was re-sealed rather than moved: the ciphertext is bound
    // to the path, so reading it back at the new path must still work.
    expect(await vault.read('journal/august.md.enc')).toBe('# August\n\nprivate thoughts\n');
    expect(remote.read('journal/august.md.enc')).not.toBe(remote.read('journal/aug.md.enc'));
  });

  it('refuses to wrap the vault key under a passphrase that is not this vault’s', async () => {
    // A typo here would be discovered at the next unlock, long after the
    // recovery key had been put away.
    const session = fakeSession({ verifyPassphrase: () => Promise.resolve(false) });
    const { vault } = harness({ session, remote: fakeRemote({ 'a.md': 'x' }) });
    await vault.load();

    await expect(vault.createVaultKey('a different passphrase')).rejects.toThrow(
      /not the passphrase this vault is unlocked with/,
    );
    expect(vault.state().hasVaultKeyFile).toBe(false);
  });

  it('refuses to encrypt before the vault key exists', async () => {
    const { vault } = harness({ remote: fakeRemote({ 'a.md': 'x' }) });
    await vault.load();
    await expect(vault.setEncrypted('a.md', true)).rejects.toThrow(/vault key/);
  });

  it('encrypts a whole folder and reports what it did', async () => {
    const remote = fakeRemote({
      'journal/a.md': 'one',
      'journal/b.md': 'two',
      'work/c.md': 'three',
    });
    const { vault } = harness({ remote });
    await vault.load();
    await vault.createVaultKey('correct horse battery staple');

    const report = await vault.encryptFolder('journal', true);
    await vault.flush();

    expect(report.done.sort()).toEqual(['journal/a.md.enc', 'journal/b.md.enc']);
    expect(report.failed).toEqual([]);
    expect(remote.read('work/c.md')).toBe('three');
  });

  it('opens the vault as "locked" when sealed notes exist and no key is at hand', async () => {
    const { vault } = harness({
      remote: fakeRemote({ 'journal/aug.md.enc': '# topazius-encrypted v1\nTPZ1.aa.bb\n' }),
    });

    await vault.load();

    expect(vault.state().sealed).toBe('locked');
    expect(vault.state().unreadable).toEqual(['journal/aug.md.enc']);
    // The rest of the vault is still open (spec §9.8).
    expect(vault.state().paths).toEqual(['journal/aug.md.enc']);
  });

  it('remembers per-folder creation defaults', async () => {
    const { vault } = harness();
    await vault.load();
    expect(vault.folderDefault('journal')).toBe('plain');

    await vault.setFolderDefault('journal', 'encrypted');
    expect(vault.folderDefault('journal')).toBe('encrypted');
    expect(vault.folderDefault('journal/2026')).toBe('encrypted');
    expect(vault.folderDefault('work')).toBe('plain');
  });
});

describe('images', () => {
  it('stores an image, queues it, and hands back markdown pointing at it', async () => {
    const { vault, remote } = harness();
    await vault.load();

    const prepared = await vault.addImage(
      { bytes: utf8.encode('PNGDATA') as Uint8Array<ArrayBuffer>, mime: 'image/png', name: 'shot.png' },
      'work/standup.md',
    );
    await vault.flush();

    expect(prepared.path).toMatch(/^assets\/\d{4}\/\d{2}\/shot-[0-9a-f]{8}\.png$/);
    expect(prepared.markdown).toBe(`![shot.png](${prepared.path})`);
    expect(remote.read(prepared.path)).toBe('PNGDATA');
  });

  it('resolves an image back to its bytes, from cache', async () => {
    const { vault } = harness();
    await vault.load();

    const prepared = await vault.addImage(
      { bytes: utf8.encode('PNGDATA') as Uint8Array<ArrayBuffer>, mime: 'image/png', name: 'shot.png' },
      'work/standup.md',
    );

    const resolved = await vault.assetBytes('work/standup.md', prepared.path);
    expect(text(resolved?.bytes ?? new Uint8Array())).toBe('PNGDATA');
    expect(resolved?.mime).toBe('image/png');
  });

  it('fetches an image it has never seen and caches it encrypted', async () => {
    const remote = fakeRemote({ 'assets/2026/08/pic-a1b2c3d4.png': 'REMOTEBYTES' });
    const { vault } = harness({ remote });
    await vault.load();

    const resolved = await vault.assetBytes('work/standup.md', 'assets/2026/08/pic-a1b2c3d4.png');
    expect(text(resolved?.bytes ?? new Uint8Array())).toBe('REMOTEBYTES');

    const cached = await readAsset(db, 'assets/2026/08/pic-a1b2c3d4.png');
    expect(text(cached?.enc.ct ?? new Uint8Array())).not.toContain('REMOTEBYTES');
  });

  it('seals an image pasted into a sealed note, and opens it again transparently', async () => {
    const remote = fakeRemote({ 'journal/aug.md': '# August\n' });
    const { vault } = harness({ remote });
    await vault.load();
    await vault.createVaultKey('correct horse battery staple');
    await vault.setEncrypted('journal/aug.md', true);

    const prepared = await vault.addImage(
      { bytes: utf8.encode('SECRETPIXELS') as Uint8Array<ArrayBuffer>, mime: 'image/png', name: 'x.png' },
      'journal/aug.md.enc',
    );
    await vault.flush();

    expect(prepared.path.endsWith('.png.enc')).toBe(true);
    expect(remote.read(prepared.path)).not.toContain('SECRETPIXELS');
    const resolved = await vault.assetBytes('journal/aug.md.enc', prepared.path);
    expect(text(resolved?.bytes ?? new Uint8Array())).toBe('SECRETPIXELS');
  });

  it('returns null for an image the vault does not have', async () => {
    const { vault } = harness();
    await vault.load();
    expect(await vault.assetBytes('a.md', 'nope.png')).toBeNull();
  });
});

describe('conflicts', () => {
  async function conflicted() {
    const remote = fakeRemote({ 'a.md': 'original\n' });
    const { vault } = harness({ remote });
    await vault.load();

    await vault.save('a.md', 'mine\n');
    remote.write('a.md', 'theirs\n'); // somebody else committed in the meantime
    await vault.flush();

    return { vault, remote };
  }

  it('reports a conflict instead of clobbering the other side', async () => {
    const { vault, remote } = await conflicted();

    expect(vault.state().conflicts).toEqual(['a.md']);
    expect(vault.state().status).toBe('conflict');
    expect(remote.read('a.md')).toBe('theirs\n');
  });

  it('shows both sides', async () => {
    const { vault } = await conflicted();
    const conflict = await vault.conflictFor('a.md');
    expect(conflict.local).toBe('mine\n');
    expect(conflict.remote).toBe('theirs\n');
    expect(conflict.remoteMissing).toBe(false);
  });

  it('keep mine re-uploads against the remote sha', async () => {
    const { vault, remote } = await conflicted();
    await vault.resolveConflict('a.md', { kind: 'mine' });

    expect(remote.read('a.md')).toBe('mine\n');
    expect(vault.state().conflicts).toEqual([]);
    expect(vault.state().status).toBe('synced');
  });

  it('keep theirs replaces the local copy and uploads nothing', async () => {
    const { vault, remote } = await conflicted();
    await vault.resolveConflict('a.md', { kind: 'theirs' });

    expect(await vault.read('a.md')).toBe('theirs\n');
    expect(remote.read('a.md')).toBe('theirs\n');
    expect(vault.state().dirty).toEqual([]);
  });

  it('a merge uploads the merged text', async () => {
    const { vault, remote } = await conflicted();
    await vault.resolveConflict('a.md', { kind: 'merged', text: 'mine\ntheirs\n' });
    expect(remote.read('a.md')).toBe('mine\ntheirs\n');
  });
});

describe('offline', () => {
  it('keeps edits queued while offline and sends them on the next flush', async () => {
    const remote = fakeRemote({ 'a.md': 'original\n' });
    let offline = true;
    const gh: GitHubClient = {
      ...remote.client,
      putFile: (input) =>
        offline
          ? Promise.reject(new GitHubError(0, 'Could not reach GitHub. Check your connection.'))
          : remote.client.putFile(input),
    };
    const vault = createVault({ db, session: fakeSession(), config: CONFIG, gh, commitDebounceMs: 60_000 });
    open.push(vault);

    await vault.load();
    await vault.save('a.md', 'written on a train\n');
    await vault.flush();

    expect(vault.state().status).toBe('offline');
    expect(vault.state().pending).toBe(1);
    expect(remote.read('a.md')).toBe('original\n');

    offline = false;
    await vault.retry();

    expect(remote.read('a.md')).toBe('written on a train\n');
    expect(vault.state().status).toBe('synced');
    expect(vault.state().pending).toBe(0);
  });
});
