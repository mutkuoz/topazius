import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TopaziusDB, destroyVaultDB, openVaultDB } from '../src/lib/db';
import { GitHubError, type GitHubClient } from '../src/lib/github';
import { MAX_ATTEMPTS, backoffMs, commitMessage, createQueue } from '../src/lib/queue';
import { stubClient } from './helpers';

/** The happy path this suite starts from: writes succeed, deletes succeed. */
const workingClient = (overrides: Partial<GitHubClient> = {}) =>
  stubClient({
    putFile: () => Promise.resolve({ sha: 'remote-sha', size: 1 }),
    deleteFile: () => Promise.resolve(),
    ...overrides,
  });

let db: IDBPDatabase<TopaziusDB>;
const bytes = new TextEncoder().encode('# Hello');

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  db.close();
  await destroyVaultDB();
});

interface HarnessOptions {
  gh?: Partial<GitHubClient>;
  payloadSha?: string;
  missing?: boolean;
  now?: () => number;
}

function harness(options: HarnessOptions = {}) {
  const written: Array<{ path: string; sha: string }> = [];
  const conflicted: string[] = [];
  const unauthorized = vi.fn();
  const queue = createQueue({
    db,
    gh: workingClient(options.gh),
    branch: 'main',
    resolve: (path) =>
      Promise.resolve(options.missing ? null : { bytes, sha: options.payloadSha ?? 'base-sha' }),
    onWritten: (path, result) => {
      written.push({ path, sha: result.sha });
      return Promise.resolve();
    },
    onConflict: (path) => conflicted.push(path),
    onUnauthorized: unauthorized,
    ...(options.now ? { now: options.now } : {}),
  });
  return { queue, written, conflicted, unauthorized };
}

describe('commitMessage', () => {
  it('names the operation the way spec §7.2 specifies', () => {
    expect(commitMessage('put', 'work/standup.md', false)).toBe('Update work/standup.md');
    expect(commitMessage('put', 'recipes/pizza.md', true)).toBe('Create recipes/pizza.md');
    expect(commitMessage('delete', 'inbox/old.md', false)).toBe('Delete inbox/old.md');
    expect(commitMessage('put', 'assets/2026/08/pic-a1b2.png', true)).toBe(
      'Add image assets/2026/08/pic-a1b2.png',
    );
  });
});

describe('backoff', () => {
  it('doubles and caps at 60s', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(4)).toBe(8_000);
    expect(backoffMs(20)).toBe(60_000);
  });
});

describe('enqueue', () => {
  it('keeps at most one op per path so repeated saves cost one commit', async () => {
    const { queue } = harness();
    await queue.enqueuePut('note.md');
    await queue.enqueuePut('note.md');
    await queue.enqueuePut('note.md');
    expect(await queue.count()).toBe(1);
  });

  it('lets a delete supersede a queued put for the same path', async () => {
    const { queue } = harness();
    await queue.enqueuePut('note.md');
    await queue.enqueueDelete('note.md', 'remote-sha');
    const items = await db.getAll('queue');
    expect(items).toHaveLength(1);
    expect(items[0]?.op).toBe('delete');
  });

  it('drops the queued put and queues nothing when deleting a never-synced note', async () => {
    const { queue } = harness();
    await queue.enqueuePut('draft.md');
    await queue.enqueueDelete('draft.md', '');
    expect(await queue.count()).toBe(0);
  });

  it('preserves insertion order across paths, so a rename creates before it deletes', async () => {
    const { queue } = harness();
    await queue.enqueuePut('new.md');
    await queue.enqueueDelete('old.md', 'old-sha');
    expect((await db.getAll('queue')).map((item) => item.path)).toEqual(['new.md', 'old.md']);
  });
});

describe('flush', () => {
  it('uploads, reports the new sha, and empties the queue', async () => {
    const puts: unknown[] = [];
    const { queue, written } = harness({
      gh: {
        putFile: (input) => {
          puts.push(input);
          return Promise.resolve({ sha: 'fresh', size: 7 });
        },
      },
    });

    await queue.enqueuePut('note.md');
    const state = await queue.flush();

    expect(puts).toEqual([
      {
        path: 'note.md',
        bytes,
        message: 'Update note.md',
        branch: 'main',
        sha: 'base-sha',
      },
    ]);
    expect(written).toEqual([{ path: 'note.md', sha: 'fresh' }]);
    expect(state).toMatchObject({ status: 'synced', pending: 0 });
  });

  it('sends no sha for a note that does not exist remotely yet', async () => {
    let seen: { sha?: string } = {};
    const { queue } = harness({
      payloadSha: '',
      gh: {
        putFile: (input) => {
          seen = input;
          return Promise.resolve({ sha: 'created', size: 1 });
        },
      },
    });

    await queue.enqueuePut('new.md');
    await queue.flush();
    expect('sha' in seen).toBe(false);
  });

  it('drops a put whose note vanished locally instead of resurrecting it', async () => {
    const putFile = vi.fn();
    const { queue } = harness({ missing: true, gh: { putFile } });
    await queue.enqueuePut('ghost.md');
    await queue.flush();
    expect(putFile).not.toHaveBeenCalled();
    expect(await queue.count()).toBe(0);
  });

  it('processes one request at a time even when flushed concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { queue } = harness({
      gh: {
        putFile: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
          return { sha: 's', size: 1 };
        },
      },
    });

    await queue.enqueuePut('a.md');
    await queue.enqueuePut('b.md');
    await Promise.all([queue.flush(), queue.flush()]);

    expect(maxInFlight).toBe(1);
    expect(await queue.count()).toBe(0);
  });
});

describe('failure handling', () => {
  it('goes offline and keeps the item when the request never reaches GitHub', async () => {
    const { queue } = harness({
      gh: { putFile: () => Promise.reject(new GitHubError(0, 'Could not reach GitHub.')) },
    });

    await queue.enqueuePut('note.md');
    const state = await queue.flush();

    expect(state.status).toBe('offline');
    expect(await queue.count()).toBe(1);
    expect((await db.getAll('queue'))[0]?.attempts).toBe(1);
  });

  it('stops the whole flush when offline rather than burning through the queue', async () => {
    const putFile = vi.fn(() => Promise.reject(new GitHubError(0, 'offline')));
    const { queue } = harness({ gh: { putFile } });

    await queue.enqueuePut('a.md');
    await queue.enqueuePut('b.md');
    await queue.flush();

    expect(putFile).toHaveBeenCalledTimes(1);
  });

  it('locks the session on a 401 and leaves the work queued', async () => {
    const { queue, unauthorized } = harness({
      gh: { putFile: () => Promise.reject(new GitHubError(401, 'Bad credentials')) },
    });

    await queue.enqueuePut('note.md');
    await queue.flush();

    expect(unauthorized).toHaveBeenCalled();
    expect(await queue.count()).toBe(1);
  });

  it('reports a 409 as a conflict and stops retrying that path', async () => {
    const { queue, conflicted } = harness({
      gh: { putFile: () => Promise.reject(new GitHubError(409, 'does not match')) },
    });

    await queue.enqueuePut('note.md');
    const state = await queue.flush();

    expect(conflicted).toEqual(['note.md']);
    expect(state.status).toBe('conflict');
    expect(state.conflicts).toEqual(['note.md']);
    // The queue item is gone; the note stays dirty until the user resolves it.
    expect(await queue.count()).toBe(0);
  });

  it('treats a 422 "already exists" as a conflict too', async () => {
    const { queue, conflicted } = harness({
      payloadSha: '',
      gh: { putFile: () => Promise.reject(new GitHubError(422, '"sha" wasn\'t supplied.')) },
    });

    await queue.enqueuePut('note.md');
    await queue.flush();
    expect(conflicted).toEqual(['note.md']);
  });

  it('pauses until the rate limit resets', async () => {
    let clock = 1_000_000;
    const putFile = vi.fn(() =>
      Promise.reject(
        new GitHubError(403, 'API rate limit exceeded', { rateLimitRemaining: 0, retryAfter: 30 }),
      ),
    );
    const { queue } = harness({ now: () => clock, gh: { putFile } });

    await queue.enqueuePut('note.md');
    const state = await queue.flush();

    expect(state.status).toBe('paused');
    expect(state.pausedUntil).toBe(clock + 30_000);

    // A flush before the reset must not touch the network again.
    await queue.flush();
    expect(putFile).toHaveBeenCalledTimes(1);

    clock += 31_000;
    await queue.flush();
    expect(putFile).toHaveBeenCalledTimes(2);
  });

  it('backs off between attempts and stops after MAX_ATTEMPTS', async () => {
    let clock = 0;
    const putFile = vi.fn(() => Promise.reject(new GitHubError(500, 'Server error')));
    const { queue } = harness({ now: () => clock, gh: { putFile } });

    await queue.enqueuePut('note.md');
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      await queue.flush();
      clock += 120_000; // well past any backoff window
    }

    expect(putFile).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const [item] = await db.getAll('queue');
    expect(item?.attempts).toBe(MAX_ATTEMPTS);
    expect(item?.lastError).toBe('Server error');
  });

  it('honours the backoff window between flushes', async () => {
    let clock = 0;
    const putFile = vi.fn(() => Promise.reject(new GitHubError(500, 'Server error')));
    const { queue } = harness({ now: () => clock, gh: { putFile } });

    await queue.enqueuePut('note.md');
    await queue.flush();
    await queue.flush(); // still inside the 1s window
    expect(putFile).toHaveBeenCalledTimes(1);

    clock += 1_500;
    await queue.flush();
    expect(putFile).toHaveBeenCalledTimes(2);
  });

  it('retryAll clears the backoff so a stalled queue can be pushed by hand', async () => {
    let clock = 0;
    const putFile = vi
      .fn<GitHubClient['putFile']>()
      .mockRejectedValueOnce(new GitHubError(500, 'Server error'))
      .mockResolvedValue({ sha: 'ok', size: 1 });
    const { queue } = harness({ now: () => clock, gh: { putFile } });

    await queue.enqueuePut('note.md');
    await queue.flush();
    await queue.retryAll();
    const state = await queue.flush();

    expect(putFile).toHaveBeenCalledTimes(2);
    expect(state.status).toBe('synced');
  });
});

describe('persistence', () => {
  it('survives a reload: a fresh queue over the same database sees the pending work', async () => {
    const first = harness({ gh: { putFile: () => Promise.reject(new GitHubError(0, 'offline')) } });
    await first.queue.enqueuePut('note.md');
    await first.queue.flush();

    const second = harness();
    expect(await second.queue.count()).toBe(1);
    await second.queue.retryAll();
    const state = await second.queue.flush();
    expect(state).toMatchObject({ status: 'synced', pending: 0 });
    expect(second.written).toEqual([{ path: 'note.md', sha: 'remote-sha' }]);
  });
});
