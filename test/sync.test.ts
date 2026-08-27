import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SALT_BYTES, deriveKey, randomBytes } from '../src/lib/crypto';
import { type TopaziusDB, allNotes, destroyVaultDB, openVaultDB, writeNote } from '../src/lib/db';
import type { TreeEntry } from '../src/lib/github';
import { loadVault, readNoteText } from '../src/lib/sync';

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
  return {
    getRepo: vi.fn(),
    getTree: vi.fn(async () => tree),
    getBlob: vi.fn(async (sha: string) => new TextEncoder().encode(blobs[sha] ?? '')),
  };
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

    const paths = await loadVault({ gh, db, key, branch: 'main' });

    expect(paths.sort()).toEqual(['recipes/b.md', 'work/a.md']);
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

    expect(await loadVault({ gh, db, key, branch: 'main' })).toEqual(['a.md']);
    expect(gh.getBlob).toHaveBeenCalledTimes(1);
  });

  it('includes encrypted notes in the listing', async () => {
    const gh = fakeGitHub([{ path: 'journal/x.md.enc', sha: 'sha-x', size: 9 }], { 'sha-x': 'TPZ1.a.b' });
    expect(await loadVault({ gh, db, key, branch: 'main' })).toEqual(['journal/x.md.enc']);
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
    expect(await loadVault({ gh: second, db, key, branch: 'main' })).toEqual([]);
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
});

describe('readNoteText', () => {
  it('throws for a path that is not cached', async () => {
    await expect(readNoteText(db, key, 'missing.md')).rejects.toThrow(/not cached/i);
  });
});
