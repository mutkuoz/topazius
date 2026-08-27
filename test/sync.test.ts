import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SALT_BYTES, deriveKey, randomBytes } from '../src/lib/crypto';
import { type TopaziusDB, allNotes, destroyVaultDB, openVaultDB, writeNote } from '../src/lib/db';
import { GitHubError, type TreeEntry } from '../src/lib/github';
import { loadVault, readNoteText } from '../src/lib/sync';
import { stubClient } from './helpers';

let db: IDBPDatabase<TopaziusDB>;
let key: CryptoKey;

beforeEach(async () => {
  db = await openVaultDB();
  key = await deriveKey('a passphrase for tests', randomBytes(SALT_BYTES));
});

afterEach(async () => {
  db.close();
  await destroyVaultDB();
});

function fakeGitHub(tree: TreeEntry[], blobs: Record<string, string>) {
  return stubClient({
    getTree: vi.fn(async () => tree),
    getBlob: vi.fn(async (sha: string) => new TextEncoder().encode(blobs[sha] ?? '')),
  });
}

/** A GitHubClient whose getBlob() rejects for one specific sha. */
function fakeGitHubWithFailingBlob(tree: TreeEntry[], blobs: Record<string, string>, failingSha: string) {
  return stubClient({
    getTree: vi.fn(async () => tree),
    getBlob: vi.fn(async (sha: string) => {
      if (sha === failingSha) throw new Error('network hiccup');
      return new TextEncoder().encode(blobs[sha] ?? '');
    }),
  });
}

/** A GitHubClient whose getTree() always rejects. */
function fakeGitHubWithFailingTree(error: unknown = new Error('offline')) {
  return stubClient({
    getTree: vi.fn(async (): Promise<never> => {
      throw error;
    }),
  });
}

describe('loadVault', () => {
  it('caches every note in the tree and returns their paths', async () => {
    const gh = fakeGitHub(
      [
        { path: 'work/a.md', sha: 'sha-a', size: 5 },
        { path: 'recipes/b.md', sha: 'sha-b', size: 5 },
      ],
      { 'sha-a': '# A', 'sha-b': '# B' },
    );

    const { paths, failures } = await loadVault({ gh, db, key, branch: 'main' });

    expect(paths.sort()).toEqual(['recipes/b.md', 'work/a.md']);
    expect(failures).toEqual([]);
    expect(await readNoteText(db, key, 'work/a.md')).toBe('# A');
  });

  it('stores note bodies encrypted, not in the clear', async () => {
    const gh = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 5 }], { 'sha-a': 'SECRET BODY' });
    await loadVault({ gh, db, key, branch: 'main' });

    const [record] = await allNotes(db);
    expect(new TextDecoder().decode(record!.enc.ct)).not.toContain('SECRET BODY');
  });

  it('skips reserved directories and non-note files', async () => {
    const gh = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a', size: 1 },
        { path: 'assets/2026/08/pic.png', sha: 'sha-p', size: 1 },
        { path: '.topazius/vault.json', sha: 'sha-v', size: 1 },
        { path: 'README.txt', sha: 'sha-r', size: 1 },
      ],
      { 'sha-a': 'A' },
    );

    expect((await loadVault({ gh, db, key, branch: 'main' })).paths).toEqual(['a.md']);
    expect(gh.getBlob).toHaveBeenCalledTimes(1);
  });

  it('includes encrypted notes in the listing', async () => {
    const gh = fakeGitHub([{ path: 'journal/x.md.enc', sha: 'sha-x', size: 9 }], { 'sha-x': 'TPZ1.a.b' });
    expect((await loadVault({ gh, db, key, branch: 'main' })).paths).toEqual(['journal/x.md.enc']);
  });

  it('refetches only blobs whose sha changed', async () => {
    const first = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a1', size: 1 },
        { path: 'b.md', sha: 'sha-b1', size: 1 },
      ],
      { 'sha-a1': 'A1', 'sha-b1': 'B1' },
    );
    await loadVault({ gh: first, db, key, branch: 'main' });
    expect(first.getBlob).toHaveBeenCalledTimes(2);

    const second = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a1', size: 1 },
        { path: 'b.md', sha: 'sha-b2', size: 1 },
      ],
      { 'sha-b2': 'B2' },
    );
    await loadVault({ gh: second, db, key, branch: 'main' });

    expect(second.getBlob).toHaveBeenCalledTimes(1);
    expect(second.getBlob).toHaveBeenCalledWith('sha-b2');
    expect(await readNoteText(db, key, 'b.md')).toBe('B2');
    expect(await readNoteText(db, key, 'a.md')).toBe('A1');
  });

  it('evicts notes that disappeared from the remote', async () => {
    const first = fakeGitHub([{ path: 'gone.md', sha: 'sha-g', size: 1 }], { 'sha-g': 'G' });
    await loadVault({ gh: first, db, key, branch: 'main' });

    const second = fakeGitHub([], {});
    expect((await loadVault({ gh: second, db, key, branch: 'main' })).paths).toEqual([]);
    expect(await allNotes(db)).toEqual([]);
  });

  it('never discards a note with unsynced local edits', async () => {
    const gh = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 1 }], { 'sha-a': 'REMOTE' });
    await loadVault({ gh, db, key, branch: 'main' });

    const [record] = await allNotes(db);
    await writeNote(db, { ...record!, dirty: true });

    const second = fakeGitHub([{ path: 'a.md', sha: 'sha-changed', size: 1 }], { 'sha-changed': 'NEWER' });
    await loadVault({ gh: second, db, key, branch: 'main' });

    expect(second.getBlob).not.toHaveBeenCalled();
    expect(await readNoteText(db, key, 'a.md')).toBe('REMOTE');
  });

  it('keeps a dirty note that vanished from the remote', async () => {
    const first = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 1 }], { 'sha-a': 'MINE' });
    await loadVault({ gh: first, db, key, branch: 'main' });

    const [record] = await allNotes(db);
    await writeNote(db, { ...record!, dirty: true });

    await loadVault({ gh: fakeGitHub([], {}), db, key, branch: 'main' });
    expect(await allNotes(db)).toHaveLength(1);
  });

  it('reports progress as blobs land', async () => {
    const gh = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a', size: 1 },
        { path: 'b.md', sha: 'sha-b', size: 1 },
      ],
      { 'sha-a': 'A', 'sha-b': 'B' },
    );
    const seen: number[] = [];
    await loadVault({ gh, db, key, branch: 'main', onProgress: (p) => seen.push(p.fetched) });
    expect(seen).toEqual([1, 2]);
  });

  it('binds the note path as AAD, so a cached record cannot be decrypted under a different path', async () => {
    const gh = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 1 }], { 'sha-a': 'A' });
    await loadVault({ gh, db, key, branch: 'main' });

    const [record] = await allNotes(db);
    // Same ciphertext, re-keyed under a different path - simulates an
    // attacker (or a bug) relocating the record rather than the note
    // actually living at that path.
    await writeNote(db, { ...record!, path: 'b.md' });

    await expect(readNoteText(db, key, 'b.md')).rejects.toThrow();
  });

  describe('partial failure', () => {
    it('reports a failed blob in `failures` without dropping any other path or throwing', async () => {
      const gh = fakeGitHubWithFailingBlob(
        [
          { path: 'good.md', sha: 'sha-good', size: 1 },
          { path: 'bad.md', sha: 'sha-bad', size: 1 },
        ],
        { 'sha-good': 'GOOD' },
        'sha-bad',
      );

      const { paths, failures } = await loadVault({ gh, db, key, branch: 'main' });

      expect(paths.sort()).toEqual(['bad.md', 'good.md']);
      expect(failures).toEqual([{ path: 'bad.md', error: 'network hiccup' }]);
      expect(await readNoteText(db, key, 'good.md')).toBe('GOOD');
    });

    it('falls back to the cached paths and reports the failure when getTree() itself fails', async () => {
      const gh = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 1 }], { 'sha-a': 'A' });
      await loadVault({ gh, db, key, branch: 'main' }); // populate the cache first

      const offline = fakeGitHubWithFailingTree(new Error('Could not reach GitHub. Check your connection.'));
      const { paths, failures } = await loadVault({ gh: offline, db, key, branch: 'main' });

      expect(paths).toEqual(['a.md']);
      expect(failures).toEqual([
        { path: '', error: 'Could not reach GitHub. Check your connection.' },
      ]);
      // The cache is untouched - still readable, nothing was evicted.
      expect(await readNoteText(db, key, 'a.md')).toBe('A');
    });

    it('re-throws a 401 from getTree() instead of swallowing it into failures, so the caller can lock', async () => {
      const gh = fakeGitHubWithFailingTree(new GitHubError(401, 'Bad credentials'));
      await expect(loadVault({ gh, db, key, branch: 'main' })).rejects.toMatchObject({ status: 401 });
    });

    it('re-throws a 401 from getBlob() instead of folding it into failures', async () => {
      const gh = stubClient({
        getTree: vi.fn(async () => [{ path: 'a.md', sha: 'sha-a', size: 1 }]),
        getBlob: vi.fn(async (): Promise<never> => {
          throw new GitHubError(401, 'Bad credentials');
        }),
      });

      await expect(loadVault({ gh, db, key, branch: 'main' })).rejects.toMatchObject({ status: 401 });
    });
  });
});

describe('readNoteText', () => {
  it('throws for a path that is not cached', async () => {
    await expect(readNoteText(db, key, 'missing.md')).rejects.toThrow(/not cached/i);
  });
});
