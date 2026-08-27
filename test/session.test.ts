import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TopaziusDB, destroyVaultDB, openVaultDB, readSecret } from '../src/lib/db';
import { MIN_PASSPHRASE_LENGTH, createSession } from '../src/lib/session';

const TOKEN = 'github_pat_11ABCDEF_supersecretvalue';
const PASS = 'correct horse battery';

let db: IDBPDatabase<TopaziusDB>;

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  db.close();
  await destroyVaultDB();
  vi.useRealTimers();
});

const session = (idleMinutes = 15) => createSession({ db, idleMinutes });

/** The empty-vs-locked distinction needs one async storage probe to settle. */
function settled(s: ReturnType<typeof session>): Promise<void> {
  return new Promise((resolve) => {
    const stop = s.onChange(() => {
      stop();
      resolve();
    });
  });
}

describe('enrolment', () => {
  it('starts empty before a token is enrolled', async () => {
    const s = session();
    await settled(s);
    expect(s.state()).toBe('empty');
  });

  it('stores the token encrypted, never in the clear', async () => {
    await session().enroll(TOKEN, PASS);

    const stored = await readSecret(db);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored!.ct)).not.toContain('supersecret');
    expect(JSON.stringify(Array.from(stored!.ct))).not.toContain(TOKEN);
  });

  it('leaves the session unlocked after enrolling', async () => {
    const s = session();
    await s.enroll(TOKEN, PASS);
    expect(s.state()).toBe('unlocked');
    expect(s.getToken()).toBe(TOKEN);
  });

  it('rejects a passphrase below the minimum length', async () => {
    await expect(session().enroll(TOKEN, 'short')).rejects.toThrow(/at least/i);
    expect(MIN_PASSPHRASE_LENGTH).toBe(10);
  });
});

describe('unlock', () => {
  it('recovers the token with the right passphrase', async () => {
    await session().enroll(TOKEN, PASS);

    const fresh = session();
    await fresh.unlock(PASS);
    expect(fresh.getToken()).toBe(TOKEN);
    expect(fresh.state()).toBe('unlocked');
  });

  it('refuses the wrong passphrase and stays locked', async () => {
    await session().enroll(TOKEN, PASS);

    const fresh = session();
    await expect(fresh.unlock('wrong passphrase')).rejects.toThrow();
    expect(fresh.state()).toBe('locked');
  });

  it('refuses to unlock a vault with no enrolled token', async () => {
    await expect(session().unlock(PASS)).rejects.toThrow(/no token/i);
  });
});

describe('lock', () => {
  it('drops the token and the key', async () => {
    const s = session();
    await s.enroll(TOKEN, PASS);
    s.lock();

    expect(s.state()).toBe('locked');
    expect(() => s.getToken()).toThrow(/locked/i);
    expect(() => s.getKey()).toThrow(/locked/i);
  });

  it('locks automatically once the idle timeout elapses', async () => {
    const s = session(15);
    await s.enroll(TOKEN, PASS);
    vi.useFakeTimers();

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(s.state()).toBe('unlocked');

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(s.state()).toBe('locked');
  });

  it('defers the auto-lock when activity is reported', async () => {
    const s = session(15);
    await s.enroll(TOKEN, PASS);
    vi.useFakeTimers();

    vi.advanceTimersByTime(14 * 60 * 1000);
    s.touch();
    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(s.state()).toBe('unlocked');

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(s.state()).toBe('locked');
  });

  it('never auto-locks when the timeout is disabled', async () => {
    const s = session(0);
    await s.enroll(TOKEN, PASS);
    vi.useFakeTimers();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(s.state()).toBe('unlocked');
  });

  it('notifies subscribers when the state changes', async () => {
    const s = session();
    await settled(s);

    const seen = vi.fn();
    const unsubscribe = s.onChange(seen);

    await s.enroll(TOKEN, PASS);
    s.lock();
    expect(seen).toHaveBeenCalledTimes(2);

    unsubscribe();
    await s.unlock(PASS);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('logout', () => {
  it('destroys the database and returns to empty', async () => {
    const s = session();
    await s.enroll(TOKEN, PASS);
    await s.logout();

    expect(s.state()).toBe('empty');
    const reopened = await openVaultDB();
    expect(await readSecret(reopened)).toBeUndefined();
    reopened.close();
  });
});
