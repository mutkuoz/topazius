import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TopaziusDB, destroyVaultDB, openVaultDB } from '../src/lib/db';
import { createSession } from '../src/lib/session';
import { Lock } from '../src/ui/Lock';

let db: IDBPDatabase<TopaziusDB>;

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  cleanup();
  db.close();
  await destroyVaultDB();
});

describe('<Lock />', () => {
  it('unlocks with the right passphrase', async () => {
    const session = createSession({ db });
    await session.enroll('github_pat_x', 'a good long passphrase');
    session.lock();

    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<Lock session={session} onUnlocked={onUnlocked} onForgot={vi.fn()} />);

    await user.type(screen.getByLabelText(/passphrase/i), 'a good long passphrase');
    await user.click(screen.getByRole('button', { name: /^unlock/i }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(session.state()).toBe('unlocked');
  });

  it('reports a wrong passphrase and stays locked', async () => {
    const session = createSession({ db });
    await session.enroll('github_pat_x', 'a good long passphrase');
    session.lock();

    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<Lock session={session} onUnlocked={onUnlocked} onForgot={vi.fn()} />);

    await user.type(screen.getByLabelText(/passphrase/i), 'not the passphrase');
    await user.click(screen.getByRole('button', { name: /^unlock/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/passphrase/i);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(session.state()).toBe('locked');
  });

  it('names the repository it is about to open', () => {
    render(
      <Lock
        session={createSession({ db })}
        config={{ owner: 'me', repo: 'my-notes', branch: 'main', prefs: {} }}
        onUnlocked={vi.fn()}
        onForgot={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain('me/my-notes');
  });

  it('offers a way out for a forgotten passphrase', async () => {
    const onForgot = vi.fn();
    const user = userEvent.setup();
    render(<Lock session={createSession({ db })} onUnlocked={vi.fn()} onForgot={onForgot} />);

    await user.click(screen.getByRole('button', { name: /forgot/i }));
    expect(onForgot).toHaveBeenCalled();
  });
});
