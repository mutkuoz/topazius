import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { IDBPDatabase } from 'idb';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import * as dbModule from '../src/lib/db';
import { type TopaziusDB, destroyVaultDB } from '../src/lib/db';

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
