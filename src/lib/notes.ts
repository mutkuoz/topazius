import type { IDBPDatabase } from 'idb';
import { decrypt, encrypt } from './crypto';
import { type TopaziusDB, allNotes, deleteNote, readNote, writeNote } from './db';
import { rewriteLinks } from './links';
import { openNote, sealNote } from './noteenc';
import { PathError, isEncryptedPath, isNotePath, isReservedPath, noteStem, normalizePath } from './paths';

/**
 * Note operations against the *local* cache. Nothing here talks to GitHub:
 * every write lands in IndexedDB first and leaves a queue entry behind, which
 * is what "local-first" means in spec §3.2 - typing never waits on a network.
 */
export interface NoteDeps {
  db: IDBPDatabase<TopaziusDB>;
  /** The session key; encrypts the cache at rest (spec §6). */
  key: CryptoKey;
  /** The vault master key, when the vault has encryption. Null seals nothing. */
  vmk: CryptoKey | null;
}

const utf8 = new TextEncoder();

/** The cache binds each record to its path as AAD, so a record cannot be relocated. */
const aad = (path: string) => utf8.encode(path);

export class NoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteError';
  }
}

/**
 * The exact bytes of the file as GitHub holds it: sealed text for a `.md.enc`
 * note, the note itself for a `.md` one. This is what the cache stores, so the
 * cached sha always describes the cached content.
 */
async function fileTextFor(deps: NoteDeps, path: string, source: string): Promise<string> {
  if (!isEncryptedPath(path)) return source;
  if (!deps.vmk) {
    throw new NoteError('This vault is locked for encrypted notes. Unlock it to save this note.');
  }
  return sealNote(deps.vmk, path, source);
}

/** Read the file exactly as stored, without unsealing. */
export async function readFileText(deps: NoteDeps, path: string): Promise<string> {
  const record = await readNote(deps.db, path);
  if (!record) throw new NoteError(`Note "${path}" is not cached.`);
  return new TextDecoder().decode(await decrypt(deps.key, record.enc, aad(path)));
}

/** Read a note as the user wrote it: unsealed when the note is encrypted. */
export async function readSource(deps: NoteDeps, path: string): Promise<string> {
  const text = await readFileText(deps, path);
  if (!isEncryptedPath(path)) return text;
  if (!deps.vmk) {
    throw new NoteError('This note is encrypted. Unlock the vault key to read it.');
  }
  return openNote(deps.vmk, path, text);
}

export interface WriteOptions {
  /** The sha this content is based on. Omitted keeps whatever the record has. */
  sha?: string;
  dirty?: boolean;
}

/** Write a note into the cache, sealing it first when the path says to. */
export async function writeSource(
  deps: NoteDeps,
  path: string,
  source: string,
  options: WriteOptions = {},
): Promise<void> {
  const fileText = await fileTextFor(deps, path, source);
  const bytes = utf8.encode(fileText);
  const existing = await readNote(deps.db, path);

  await writeNote(deps.db, {
    path,
    sha: options.sha ?? existing?.sha ?? '',
    size: bytes.length,
    enc: await encrypt(deps.key, bytes as Uint8Array<ArrayBuffer>, aad(path)),
    mtime: Date.now(),
    dirty: options.dirty ?? true,
  });
}

/** After a successful upload: adopt the sha GitHub assigned and stop being dirty. */
export async function markSynced(
  db: IDBPDatabase<TopaziusDB>,
  path: string,
  sha: string,
  size: number,
): Promise<void> {
  const record = await readNote(db, path);
  if (!record) return;
  await writeNote(db, { ...record, sha, size, dirty: false });
}

/**
 * Validate a path the user typed or a rename produced. Adds the note-specific
 * rules paths.ts does not own: notes must be markdown, and must not sit inside
 * a reserved directory.
 */
export function validateNotePath(input: string): string {
  const path = normalizePath(input.trim());
  if (isReservedPath(path)) {
    throw new PathError('assets/ and .topazius/ are reserved for Topazius.');
  }
  if (!isNotePath(path)) {
    throw new PathError('A note must end in .md.');
  }
  return path;
}

/** Both states of a note are the same note; they must never coexist (spec §4.3). */
export function conflictsWithExisting(path: string, existing: Iterable<string>): string | null {
  const stem = noteStem(path);
  for (const candidate of existing) {
    if (noteStem(candidate) === stem) return candidate;
  }
  return null;
}

export async function removeNote(deps: NoteDeps, path: string): Promise<string> {
  const record = await readNote(deps.db, path);
  await deleteNote(deps.db, path);
  return record?.sha ?? '';
}

export interface RenamePlan {
  from: string;
  to: string;
  /** The sha of the old file, needed to delete it remotely. */
  fromSha: string;
  /** Notes whose inbound wikilinks were rewritten. */
  relinked: string[];
}

/**
 * Rename, move, or toggle encryption: all one operation, because all three are
 * "the same note at a different path" (spec §4.3, §9.5).
 *
 * The new copy is written before the old one is removed, and the queue keeps
 * that order, so an interruption leaves two copies rather than none. An
 * encrypted note is re-sealed on the way, because its path is part of its AAD.
 */
export async function renameNote(deps: NoteDeps, from: string, to: string): Promise<RenamePlan> {
  if (from === to) throw new NoteError('That is already the note’s path.');
  const source = await readSource(deps, from);
  const existing = (await allNotes(deps.db)).map((note) => note.path);

  const clash = conflictsWithExisting(to, existing.filter((path) => path !== from));
  if (clash) {
    throw new NoteError(
      clash === to ? `"${to}" already exists.` : `"${clash}" is the same note in its other state.`,
    );
  }

  await writeSource(deps, to, source, { sha: '', dirty: true });
  const fromSha = await removeNote(deps, from);

  // Inbound links are rewritten in the same batch, so no link is ever left
  // pointing at a path that no longer exists. `existing` is the vault as it
  // was *before* the move, which is what a link in it still resolves against;
  // rewriteLinks() works out the after-state itself.
  const relinked: string[] = [];
  for (const path of existing) {
    if (path === from) continue;
    const body = await readSource(deps, path);
    const rewritten = rewriteLinks(body, from, to, existing);
    if (rewritten === body) continue;
    await writeSource(deps, path, rewritten, { dirty: true });
    relinked.push(path);
  }

  return { from, to, fromSha, relinked };
}
