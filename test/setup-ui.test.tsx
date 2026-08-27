import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { IDBPDatabase } from 'idb';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TopaziusDB, destroyVaultDB, openVaultDB, readConfig } from '../src/lib/db';
import { createSession } from '../src/lib/session';
import { Setup, validateSetup } from '../src/ui/Setup';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let db: IDBPDatabase<TopaziusDB>;

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  cleanup();
  server.resetHandlers();
  db.close();
  await destroyVaultDB();
});

function repoResponds(body: JsonBodyType, init?: ResponseInit) {
  server.use(http.get('https://api.github.com/repos/me/my-notes', () => HttpResponse.json(body, init)));
}

async function fillForm(passphrase: string, confirm = passphrase) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/owner/i), 'me');
  await user.type(screen.getByLabelText(/repository name/i), 'my-notes');
  await user.type(screen.getByLabelText(/access token/i), 'github_pat_x');
  await user.type(screen.getByLabelText(/^passphrase/i), passphrase);
  await user.type(screen.getByLabelText(/confirm/i), confirm);
  await user.click(screen.getByRole('button', { name: /unlock vault/i }));
}

describe('validateSetup', () => {
  it('returns the default branch with no warnings for a well-scoped token', async () => {
    repoResponds({ default_branch: 'trunk', private: true, permissions: { push: true } });

    expect(await validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' })).toEqual({
      branch: 'trunk',
      warnings: [],
    });
  });

  it('warns when the token is a classic PAT', async () => {
    repoResponds(
      { default_branch: 'main', private: true, permissions: { push: true } },
      { headers: { 'X-OAuth-Scopes': 'repo' } },
    );

    const result = await validateSetup({ owner: 'me', repo: 'my-notes', token: 'ghp_x' });
    expect(result.warnings.join(' ')).toMatch(/classic/i);
  });

  it('warns when the repository is public', async () => {
    repoResponds({ default_branch: 'main', private: false, permissions: { push: true } });

    const result = await validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' });
    expect(result.warnings.join(' ')).toMatch(/public/i);
  });

  it('rejects a token without write access', async () => {
    repoResponds({ default_branch: 'main', private: true, permissions: { push: false } });

    await expect(validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' })).rejects.toThrow(
      /write/i,
    );
  });

  it('turns a 404 into guidance about the repo name and token scope', async () => {
    repoResponds({ message: 'Not Found' }, { status: 404 });

    await expect(validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' })).rejects.toThrow(
      /could not find/i,
    );
  });

  it('turns a 401 into guidance about the token itself', async () => {
    repoResponds({ message: 'Bad credentials' }, { status: 401 });

    await expect(validateSetup({ owner: 'me', repo: 'my-notes', token: 'bad' })).rejects.toThrow(
      /rejected that token/i,
    );
  });
});

describe('<Setup />', () => {
  it('enrols the token and stores the resolved branch on success', async () => {
    repoResponds({ default_branch: 'trunk', private: true, permissions: { push: true } });
    const session = createSession({ db });
    const onDone = vi.fn();

    render(<Setup db={db} session={session} onDone={onDone} />);
    await fillForm('a good long passphrase');

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await readConfig(db)).toMatchObject({ owner: 'me', repo: 'my-notes', branch: 'trunk' });
    expect(session.state()).toBe('unlocked');
  });

  it('refuses mismatched passphrases', async () => {
    const session = createSession({ db });

    render(<Setup db={db} session={session} onDone={vi.fn()} />);
    await fillForm('a good long passphrase', 'a different passphrase');

    expect(await screen.findByRole('alert')).toHaveTextContent(/match/i);
    expect(session.state()).not.toBe('unlocked');
  });

  it('refuses a passphrase below the minimum length', async () => {
    render(<Setup db={db} session={createSession({ db })} onDone={vi.fn()} />);
    await fillForm('short');

    expect(await screen.findByRole('alert')).toHaveTextContent(/10 characters/i);
  });

  it('surfaces a validation failure without enrolling anything', async () => {
    repoResponds({ message: 'Bad credentials' }, { status: 401 });
    const session = createSession({ db });

    render(<Setup db={db} session={session} onDone={vi.fn()} />);
    await fillForm('a good long passphrase');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(session.state()).not.toBe('unlocked');
    expect(await readConfig(db)).toBeUndefined();
  });

  it('warns that the passphrase cannot be recovered', () => {
    render(<Setup db={db} session={createSession({ db })} onDone={vi.fn()} />);
    expect(document.body.textContent).toMatch(/cannot be recovered/i);
  });

  it('holds a public-repository warning for acknowledgement before persisting anything', async () => {
    repoResponds({ default_branch: 'main', private: false, permissions: { push: true } });
    const session = createSession({ db });
    const onDone = vi.fn();

    render(<Setup db={db} session={session} onDone={onDone} />);
    await fillForm('a good long passphrase');

    expect(await screen.findByText(/public/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(await readConfig(db)).toBeUndefined();
    expect(session.state()).not.toBe('unlocked');

    await userEvent.setup().click(screen.getByRole('button', { name: /understand/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await readConfig(db)).toMatchObject({ owner: 'me', repo: 'my-notes', branch: 'main' });
    expect(session.state()).toBe('unlocked');
  });

  it('holds a classic-token warning for acknowledgement before persisting anything', async () => {
    repoResponds(
      { default_branch: 'main', private: true, permissions: { push: true } },
      { headers: { 'X-OAuth-Scopes': 'repo' } },
    );
    const session = createSession({ db });
    const onDone = vi.fn();

    render(<Setup db={db} session={session} onDone={onDone} />);
    await fillForm('a good long passphrase');

    expect(await screen.findByText(/classic/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(await readConfig(db)).toBeUndefined();
    expect(session.state()).not.toBe('unlocked');

    await userEvent.setup().click(screen.getByRole('button', { name: /understand/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await readConfig(db)).toMatchObject({ owner: 'me', repo: 'my-notes', branch: 'main' });
    expect(session.state()).toBe('unlocked');
  });
});
