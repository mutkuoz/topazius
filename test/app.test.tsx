import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { IDBPDatabase } from 'idb';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import * as dbModule from '../src/lib/db';
import { type TopaziusDB, destroyVaultDB } from '../src/lib/db';
import * as sessionModule from '../src/lib/session';
import type { Session } from '../src/lib/session';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

// resetVault() opens a fresh db handle that lives only in App's internal
// state, unreachable from the test. Spy on the module's openVaultDB so every
// handle it hands out - the initial one and any post-reset one - is tracked
// and can be closed in afterEach. Without this, a still-open handle would
// leave destroyVaultDB()'s deleteDB() blocked forever (see session.ts).
const originalOpenVaultDB = dbModule.openVaultDB;
let opened: IDBPDatabase<TopaziusDB>[] = [];

beforeEach(() => {
  opened = [];
  vi.spyOn(dbModule, 'openVaultDB').mockImplementation(async () => {
    const handle = await originalOpenVaultDB();
    opened.push(handle);
    return handle;
  });

  server.use(
    http.get('https://api.github.com/repos/me/my-notes', () =>
      HttpResponse.json({ default_branch: 'main', private: true, permissions: { push: true } }),
    ),
    http.get('https://api.github.com/repos/me/my-notes/git/trees/main', () =>
      HttpResponse.json({ truncated: false, tree: [] }),
    ),
  );
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  server.resetHandlers();
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed by logout() */
    }
  }
  await destroyVaultDB();
});

// resetVault() briefly flickers: the old session's logout() fires its own
// final notify() while `session` state still points at it (rendering the
// destroyed vault's now-empty state for an instant), before setSession()
// swaps in the real fresh session. Waiting for the heading once can catch
// that transient render right before it is replaced. Confirm it is still
// standing a moment later before treating the screen as settled.
async function waitSettled(matcher: () => HTMLElement) {
  await waitFor(() => expect(matcher()).toBeInTheDocument());
  await new Promise((r) => setTimeout(r, 30));
  await waitFor(() => expect(matcher()).toBeInTheDocument());
}

async function enroll(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/owner/i), 'me');
  await user.type(screen.getByLabelText(/repository name/i), 'my-notes');
  await user.type(screen.getByLabelText(/access token/i), 'github_pat_x');
  await user.type(screen.getByLabelText(/^passphrase/i), 'a good long passphrase');
  await user.type(screen.getByLabelText(/confirm/i), 'a good long passphrase');
  await user.click(screen.getByRole('button', { name: /unlock vault/i }));
}

/**
 * A minimal Session double for tests that exercise app.tsx's own logic (the
 * hidden-tab timer) rather than session.ts's. No PBKDF2, no credentials.
 */
function fakeSession(): Session {
  const listeners = new Set<() => void>();
  return {
    state: () => 'unlocked',
    enroll: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(),
    getToken: () => 'token',
    getKey: () => {
      throw new Error('not needed by this test');
    },
    getVaultKey: () => null,
    createVaultKey: vi.fn(),
    openVaultKey: vi.fn(),
    regenerateRecoveryKey: vi.fn(),
    touch: vi.fn(),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logout: vi.fn(async () => {}),
  };
}

describe('App: hidden-tab lock (spec §5.3)', () => {
  it('locks on return to visible when the tab was hidden long enough but the timer never fired', async () => {
    // Reproduces a frozen mobile tab, bfcache, or laptop sleep: the wall
    // clock advances past the 5-minute mark while hidden, but nothing runs
    // to fire the pending setTimeout. vi.setSystemTime moves the clock
    // without running the timer queue - vi.advanceTimersByTime would fire
    // the timer itself and mask exactly the bug this test targets.
    vi.useFakeTimers();
    const db = await dbModule.openVaultDB();
    const session = fakeSession();
    vi.spyOn(sessionModule, 'createSession').mockReturnValue(session);

    render(<App db={db} />);

    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));

    vi.setSystemTime(Date.now() + 6 * 60_000);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(session.lock).toHaveBeenCalled();
    db.close();
  });

  it('does not lock on return to visible after a short hidden spell', async () => {
    vi.useFakeTimers();
    const db = await dbModule.openVaultDB();
    const session = fakeSession();
    vi.spyOn(sessionModule, 'createSession').mockReturnValue(session);

    render(<App db={db} />);

    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));

    vi.setSystemTime(Date.now() + 2 * 60_000);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(session.lock).not.toHaveBeenCalled();
    db.close();
  });
});

describe('App: reset-vault failure', () => {
  it('shows a visible failure instead of hanging silently when resetVault cannot reopen storage', async () => {
    const db = await dbModule.openVaultDB();
    const user = userEvent.setup();
    render(<App db={db} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /connect your vault/i })).toBeInTheDocument(),
    );
    await enroll(user);
    await waitFor(() => expect(screen.getByText(/0 notes/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^lock$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /^unlock$/i })).toBeInTheDocument());

    // The next openVaultDB() call - the one resetVault() makes right after
    // session.logout() - rejects, simulating storage becoming unavailable
    // mid-recovery (private browsing toggled, quota refused, ...).
    vi.spyOn(dbModule, 'openVaultDB').mockImplementationOnce(async () => {
      throw new Error('storage unavailable');
    });

    await user.click(screen.getByRole('button', { name: /forgot/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(await screen.findByText(/storage unavailable/i)).toBeInTheDocument();
  });
});

describe('App: 401 locks the session (spec §5.3)', () => {
  it('locks and reports a rejected token when loading the vault gets a 401', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/trees/main', () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );

    const db = await dbModule.openVaultDB();
    const user = userEvent.setup();
    render(<App db={db} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /connect your vault/i })).toBeInTheDocument(),
    );
    await enroll(user);

    await waitFor(() => expect(screen.getByRole('heading', { name: /^unlock$/i })).toBeInTheDocument());
    expect(screen.getByText(/rejected your token/i)).toBeInTheDocument();
  });
});

describe('App: logout recovery', () => {
  it('recovers a usable database after "I forgot my passphrase" instead of dying with InvalidStateError', async () => {
    const db = await dbModule.openVaultDB();
    const user = userEvent.setup();
    render(<App db={db} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /connect your vault/i })).toBeInTheDocument(),
    );
    await enroll(user);
    await waitFor(() => expect(screen.getByText(/0 notes/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^lock$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /^unlock$/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /forgot/i }));

    // Lands back on Setup rather than staying stuck.
    await waitSettled(() => screen.getByRole('heading', { name: /connect your vault/i }));

    // Enrolling again exercises Setup's writeConfig(db, ...) against the
    // App's *current* handle. Before the fix, App kept using the closed
    // pre-logout handle and this threw InvalidStateError, surfacing as an
    // alert instead of completing.
    await enroll(user);
    await waitFor(() => expect(screen.getByText(/0 notes/i)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
