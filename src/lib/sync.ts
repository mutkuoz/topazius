import type { IDBPDatabase } from 'idb';
import { BLOB_CONCURRENCY, mapWithConcurrency } from './concurrency';
import { decrypt, encrypt } from './crypto';
import { type TopaziusDB, allNotes, deleteNote, readNote, writeNote } from './db';
import type { GitHubClient } from './github';
import { isNotePath, isReservedPath } from './paths';

export interface LoadProgress {
  fetched: number;
  total: number;
  path: string;
}

export interface LoadDeps {
  gh: GitHubClient;
  db: IDBPDatabase<TopaziusDB>;
  key: CryptoKey;
  branch: string;
  onProgress?: (progress: LoadProgress) => void;
}

/**
 * Bring the local cache in line with the remote tree and return every note path.
 * Only blobs whose sha changed are fetched. Notes with unsynced local edits are
 * never overwritten or evicted - plan 2's conflict flow owns those.
 */
export async function loadVault(deps: LoadDeps): Promise<string[]> {
  const entries = (await deps.gh.getTree(deps.branch)).filter(
    (entry) => isNotePath(entry.path) && !isReservedPath(entry.path),
  );

  const remotePaths = new Set(entries.map((entry) => entry.path));
  for (const cached of await allNotes(deps.db)) {
    if (!remotePaths.has(cached.path) && !cached.dirty) {
      await deleteNote(deps.db, cached.path);
    }
  }

  const stale: typeof entries = [];
  for (const entry of entries) {
    const cached = await readNote(deps.db, entry.path);
    if (cached?.dirty) continue;
    if (cached?.sha !== entry.sha) stale.push(entry);
  }

  let fetched = 0;
  await mapWithConcurrency(stale, BLOB_CONCURRENCY, async (entry) => {
    const bytes = await deps.gh.getBlob(entry.sha);
    await writeNote(deps.db, {
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
      enc: await encrypt(deps.key, bytes),
      mtime: Date.now(),
      dirty: false,
    });
    fetched++;
    deps.onProgress?.({ fetched, total: stale.length, path: entry.path });
  });

  return entries.map((entry) => entry.path);
}

export async function readNoteText(
  db: IDBPDatabase<TopaziusDB>,
  key: CryptoKey,
  path: string,
): Promise<string> {
  const record = await readNote(db, path);
  if (!record) throw new Error(`Note "${path}" is not cached.`);
  return new TextDecoder().decode(await decrypt(key, record.enc));
}
