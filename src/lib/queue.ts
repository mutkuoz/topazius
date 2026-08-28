import type { IDBPDatabase } from 'idb';
import type { QueueItem, TopaziusDB } from './db';
import { GitHubError, type GitHubClient, type WriteResult } from './github';

/** What the status chip shows, worst-first when several apply. */
export type SyncStatus = 'synced' | 'saving' | 'offline' | 'paused' | 'conflict' | 'error';

/** Retries stop here; the item stays queued and is reported instead of spinning. */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_CAP_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;

/** Exponential backoff, capped, per spec §7.4. attempts is the count *after* the failure. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

/** What a `put` should upload, resolved at send time rather than stored in the queue. */
export interface Payload {
  bytes: Uint8Array;
  /** The sha this write is based on; '' for a file that does not exist remotely yet. */
  sha: string;
}

export interface QueueDeps {
  db: IDBPDatabase<TopaziusDB>;
  gh: GitHubClient;
  branch: string;
  /**
   * Resolve the bytes for a queued `put` at send time. Returning null means the
   * note is gone locally, so the op is dropped rather than resurrecting it.
   *
   * Reading the payload here, instead of storing it on the queue item, is what
   * keeps plaintext out of the queue store (spec §7.2): the caller hands over
   * bytes that are already sealed or already destined for the wire, and the
   * queue never holds note content at rest.
   */
  resolve: (path: string) => Promise<Payload | null>;
  /** Record the new sha and clear `dirty` after a successful put. */
  onWritten: (path: string, result: WriteResult) => Promise<void>;
  /** A 409/422 sha mismatch: the caller opens the conflict flow for this path. */
  onConflict: (path: string) => void;
  /** GitHub rejected the token; the caller locks the session. */
  onUnauthorized: () => void;
  onChange?: () => void;
  now?: () => number;
}

export interface QueueState {
  status: SyncStatus;
  pending: number;
  /** Human-readable detail for the status chip; '' when there is nothing to say. */
  message: string;
  /** Paths whose last attempt hit a conflict, awaiting resolution. */
  conflicts: string[];
  /** Wall-clock time the queue is paused until (rate limit), or 0. */
  pausedUntil: number;
}

export interface WriteQueue {
  /** Queue an upload of `path`'s current local content. */
  enqueuePut(path: string): Promise<void>;
  /** Queue a remote delete. `sha` is remembered because the local record is going away. */
  enqueueDelete(path: string, sha: string): Promise<void>;
  /** Send everything that is due. Serialised: one request in flight at a time. */
  flush(): Promise<QueueState>;
  /** Clear backoff and the attempt counters so a manual "retry now" works. */
  retryAll(): Promise<void>;
  /** Forget a conflict once it has been resolved. */
  clearConflict(path: string): void;
  state(): QueueState;
  count(): Promise<number>;
  /** Drop every queued op for a path (used when a note is deleted before it ever synced). */
  forget(path: string): Promise<void>;
}

export function commitMessage(op: 'put' | 'delete', path: string, isCreate: boolean): string {
  if (op === 'delete') return `Delete ${path}`;
  if (!isCreate) return `Update ${path}`;
  return path.startsWith('assets/') ? `Add image ${path}` : `Create ${path}`;
}

async function itemsFor(db: IDBPDatabase<TopaziusDB>, path: string): Promise<QueueItem[]> {
  return (await db.getAll('queue')).filter((item) => item.path === path);
}

export function createQueue(deps: QueueDeps): WriteQueue {
  const now = deps.now ?? Date.now;
  let status: SyncStatus = 'synced';
  let message = '';
  let pending = 0;
  let pausedUntil = 0;
  let running: Promise<QueueState> | null = null;
  const conflicts = new Set<string>();

  const state = (): QueueState => ({
    status,
    pending,
    message,
    conflicts: [...conflicts],
    pausedUntil,
  });

  function announce() {
    deps.onChange?.();
  }

  function settle(next: SyncStatus, detail = '') {
    status = next;
    message = detail;
    announce();
  }

  /**
   * At most one queued op per path: a note saved five times before the network
   * comes back should cost one commit, not five. A pending delete supersedes a
   * pending put for the same path and vice versa, because only the latest
   * intent is true.
   */
  async function replace(item: Omit<QueueItem, 'id'>): Promise<void> {
    const tx = deps.db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    for (const existing of await store.getAll()) {
      if (existing.path === item.path && existing.id !== undefined) await store.delete(existing.id);
    }
    await store.add(item as QueueItem);
    await tx.done;
    pending = await deps.db.count('queue');
    if (status === 'synced') settle('saving');
    else announce();
  }

  async function drop(id: number | undefined): Promise<void> {
    if (id === undefined) return;
    await deps.db.delete('queue', id);
  }

  async function fail(item: QueueItem, error: string): Promise<void> {
    const attempts = item.attempts + 1;
    await deps.db.put('queue', {
      ...item,
      attempts,
      lastError: error,
      notBefore: attempts >= MAX_ATTEMPTS ? Number.POSITIVE_INFINITY : now() + backoffMs(attempts),
    });
  }

  /** Runs one item. Returns false to stop the whole flush (offline, 401, rate limit). */
  async function send(item: QueueItem): Promise<boolean> {
    try {
      if (item.op === 'delete') {
        await deps.gh.deleteFile({
          path: item.path,
          sha: item.sha ?? '',
          message: commitMessage('delete', item.path, false),
          branch: deps.branch,
        });
        await drop(item.id);
        return true;
      }

      const payload = await deps.resolve(item.path);
      if (!payload) {
        // The note was deleted locally after this put was queued.
        await drop(item.id);
        return true;
      }

      const result = await deps.gh.putFile({
        path: item.path,
        bytes: payload.bytes,
        message: commitMessage('put', item.path, payload.sha === ''),
        branch: deps.branch,
        ...(payload.sha ? { sha: payload.sha } : {}),
      });
      await deps.onWritten(item.path, result);
      await drop(item.id);
      conflicts.delete(item.path);
      return true;
    } catch (error) {
      if (!(error instanceof GitHubError)) {
        await fail(item, error instanceof Error ? error.message : 'Unknown error.');
        settle('error', 'A note could not be saved.');
        return true;
      }
      return handleGitHubError(item, error);
    }
  }

  async function handleGitHubError(item: QueueItem, error: GitHubError): Promise<boolean> {
    // status 0 is github.ts's marker for "the request never reached GitHub".
    if (error.status === 0) {
      await fail(item, error.message);
      settle('offline', 'Offline — changes are queued.');
      return false;
    }

    if (error.status === 401) {
      deps.onUnauthorized();
      settle('error', 'GitHub rejected your token.');
      return false;
    }

    // 409 is the documented sha mismatch. GitHub also answers 422 when a
    // create collides with a file that already exists, which is the same
    // situation seen from the other side: somebody else wrote this path.
    if (error.status === 409 || (error.status === 422 && /sha|exists/i.test(error.message))) {
      await drop(item.id);
      conflicts.add(item.path);
      deps.onConflict(item.path);
      settle('conflict', `${item.path} changed on GitHub.`);
      return true;
    }

    if (error.status === 403 && error.rateLimitRemaining === 0) {
      pausedUntil = now() + (error.retryAfter ?? 60) * 1000;
      await fail(item, 'Rate limited.');
      settle('paused', 'GitHub rate limit reached — retrying shortly.');
      return false;
    }

    if (error.status === 403) {
      // Secondary rate limit: back off, honouring Retry-After when given.
      pausedUntil = now() + (error.retryAfter ?? 30) * 1000;
      await fail(item, error.message);
      settle('paused', 'GitHub asked us to slow down — retrying shortly.');
      return false;
    }

    await fail(item, error.message);
    settle('error', error.status === 404 ? 'That repository or branch is gone.' : error.message);
    return true;
  }

  async function run(): Promise<QueueState> {
    pending = await deps.db.count('queue');
    if (pending === 0) {
      if (conflicts.size === 0) settle('synced');
      return state();
    }
    if (pausedUntil > now()) return state();
    pausedUntil = 0;

    settle('saving', '');

    // Ordered by insertion (auto-increment key), which is what makes a rename
    // safe: its create is queued before its delete, so an interrupted rename
    // leaves both copies rather than neither (spec §4.3).
    for (const item of await deps.db.getAll('queue')) {
      if ((item.notBefore ?? 0) > now()) continue;
      if (!(await send(item))) break;
    }

    pending = await deps.db.count('queue');
    if (pending === 0 && conflicts.size === 0 && status === 'saving') settle('synced');
    else announce();
    return state();
  }

  return {
    async enqueuePut(path) {
      conflicts.delete(path);
      await replace({ op: 'put', path, attempts: 0 });
    },

    async enqueueDelete(path, sha) {
      conflicts.delete(path);
      if (sha === '') {
        // Never pushed, so there is nothing on the remote to delete. Drop any
        // queued put for it as well: uploading a note the user just deleted
        // would be worse than doing nothing.
        for (const item of await itemsFor(deps.db, path)) await drop(item.id);
        pending = await deps.db.count('queue');
        announce();
        return;
      }
      await replace({ op: 'delete', path, sha, attempts: 0 });
    },

    // A single in-flight flush at a time. Two overlapping flushes would send
    // the same item twice - the second reads the queue before the first has
    // deleted what it just uploaded.
    flush() {
      if (running) return running;
      running = run().finally(() => {
        running = null;
      });
      return running;
    },

    async retryAll() {
      pausedUntil = 0;
      const tx = deps.db.transaction('queue', 'readwrite');
      const store = tx.objectStore('queue');
      for (const item of await store.getAll()) {
        await store.put({ ...item, attempts: 0, notBefore: 0, lastError: undefined });
      }
      await tx.done;
      announce();
    },

    clearConflict(path) {
      if (conflicts.delete(path)) {
        if (conflicts.size === 0 && status === 'conflict') settle('synced');
        else announce();
      }
    },

    state,

    count() {
      return deps.db.count('queue');
    },

    async forget(path) {
      for (const item of await itemsFor(deps.db, path)) await drop(item.id);
      conflicts.delete(path);
      pending = await deps.db.count('queue');
      announce();
    },
  };
}
