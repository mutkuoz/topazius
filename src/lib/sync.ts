import type { IDBPDatabase } from 'idb';
import { BLOB_CONCURRENCY, mapWithConcurrency } from './concurrency';
import { decrypt, encrypt } from './crypto';
import { type TopaziusDB, allNotes, deleteNote, readNote, writeNote } from './db';
import { GitHubError, type GitHubClient } from './github';
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

/** A failure for one path, or - when `path` is '' - for the tree fetch itself. */
export interface LoadFailure {
  path: string;
  error: string;
}

export interface LoadResult {
  paths: string[];
  failures: LoadFailure[];
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Bring the local cache in line with the remote tree and return every note path.
 * Only blobs whose sha changed are fetched. Notes with unsynced local edits are
 * never overwritten or evicted - plan 2's conflict flow owns those.
 *
 * One bad blob, or a failed tree fetch (offline, rate-limited, 5xx), never
 * empties the vault: both fall back to whatever is already cached and report
 * themselves in `failures` rather than throwing. Cached vaults render
 * instantly per spec §7.1, and one bad file never blocks the vault per §9.8.
 *
 * A 401 is the one exception: it means the token itself is rejected, not
 * that this fetch was transient, so it propagates instead of being folded
 * into `failures` - the caller (app.tsx) locks the session on it per §5.3.
 */
export async function loadVault(deps: LoadDeps): Promise<LoadResult> {
  const failures: LoadFailure[] = [];

  let entries: Array<{ path: string; sha: string; size: number }>;
  try {
    entries = (await deps.gh.getTree(deps.branch)).filter(
      (entry) => isNotePath(entry.path) && !isReservedPath(entry.path),
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) throw error;
    const cached = await allNotes(deps.db);
    failures.push({ path: '', error: messageOf(error, 'Could not load the file tree.') });
    return { paths: cached.map((note) => note.path), failures };
  }

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
    try {
      const bytes = await deps.gh.getBlob(entry.sha);
      await writeNote(deps.db, {
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
        enc: await encrypt(deps.key, bytes),
        mtime: Date.now(),
        dirty: false,
      });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) throw error;
      failures.push({ path: entry.path, error: messageOf(error, 'Could not fetch this note.') });
    }
    fetched++;
    deps.onProgress?.({ fetched, total: stale.length, path: entry.path });
  });

  return { paths: entries.map((entry) => entry.path), failures };
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
