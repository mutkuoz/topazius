import { afterEach, describe, expect, it } from 'vitest';
import {
  allNotes,
  deleteNote,
  destroyVaultDB,
  openVaultDB,
  readConfig,
  readNote,
  readSecret,
  writeConfig,
  writeNote,
  writeSecret,
} from '../src/lib/db';
import type { NoteRecord } from '../src/lib/types';

function note(path: string, sha: string): NoteRecord {
  return {
    path,
    sha,
    size: 3,
    enc: { iv: new Uint8Array(12), ct: new Uint8Array([1, 2, 3]) },
    mtime: 1_000,
    dirty: false,
  };
}

afterEach(async () => {
  await destroyVaultDB();
});

describe('db', () => {
  it('returns undefined for config and secret on a fresh vault', async () => {
    const db = await openVaultDB();
    expect(await readConfig(db)).toBeUndefined();
    expect(await readSecret(db)).toBeUndefined();
    db.close();
  });

  it('round-trips config', async () => {
    const db = await openVaultDB();
    await writeConfig(db, { owner: 'me', repo: 'my-notes', branch: 'main', prefs: { theme: 'dark' } });
    expect(await readConfig(db)).toEqual({
      owner: 'me',
      repo: 'my-notes',
      branch: 'main',
      prefs: { theme: 'dark' },
    });
    db.close();
  });

  it('round-trips the wrapped secret including its byte arrays', async () => {
    const db = await openVaultDB();
    await writeSecret(db, {
      v: 1,
      salt: new Uint8Array([9, 9]),
      iv: new Uint8Array([8, 8]),
      ct: new Uint8Array([7, 7]),
    });
    const got = await readSecret(db);
    expect(got?.v).toBe(1);
    expect(Array.from(got!.salt)).toEqual([9, 9]);
    expect(Array.from(got!.ct)).toEqual([7, 7]);
    db.close();
  });

  it('stores notes keyed by path and lists them', async () => {
    const db = await openVaultDB();
    await writeNote(db, note('work/a.md', 'sha-a'));
    await writeNote(db, note('recipes/b.md', 'sha-b'));

    expect(await readNote(db, 'work/a.md')).toMatchObject({ sha: 'sha-a' });
    expect((await allNotes(db)).map((n) => n.path).sort()).toEqual(['recipes/b.md', 'work/a.md']);
    db.close();
  });

  it('overwrites a note written twice at the same path', async () => {
    const db = await openVaultDB();
    await writeNote(db, note('work/a.md', 'old'));
    await writeNote(db, note('work/a.md', 'new'));

    expect(await readNote(db, 'work/a.md')).toMatchObject({ sha: 'new' });
    expect(await allNotes(db)).toHaveLength(1);
    db.close();
  });

  it('deletes notes', async () => {
    const db = await openVaultDB();
    await writeNote(db, note('work/a.md', 'sha-a'));
    await deleteNote(db, 'work/a.md');
    expect(await readNote(db, 'work/a.md')).toBeUndefined();
    db.close();
  });

  it('wipes everything on destroy, as logout requires', async () => {
    const first = await openVaultDB();
    await writeNote(first, note('work/a.md', 'sha-a'));
    await writeSecret(first, { v: 1, salt: new Uint8Array(1), iv: new Uint8Array(1), ct: new Uint8Array(1) });
    first.close();

    await destroyVaultDB();

    const second = await openVaultDB();
    expect(await allNotes(second)).toEqual([]);
    expect(await readSecret(second)).toBeUndefined();
    second.close();
  });
});
