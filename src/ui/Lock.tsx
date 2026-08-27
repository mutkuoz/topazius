import { useState } from 'preact/hooks';
import type { AppConfig } from '../lib/db';
import type { Session } from '../lib/session';
import './forms.css';

export interface LockProps {
  session: Session;
  config?: AppConfig;
  onUnlocked: () => void;
  onForgot: () => void;
}

export function Lock({ session, config, onUnlocked, onForgot }: LockProps) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await session.unlock(passphrase);
      setPassphrase('');
      onUnlocked();
    } catch {
      // Wrong passphrase and corrupt blob mean the same thing at this screen,
      // and distinguishing them would leak nothing useful.
      setError('That passphrase did not unlock this vault.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="panel" onSubmit={submit}>
      <h1>Unlock</h1>
      {config && (
        <p class="hint">
          {config.owner}/{config.repo}
        </p>
      )}

      <label>
        Passphrase
        <input
          type="password"
          value={passphrase}
          onInput={(e) => setPassphrase(e.currentTarget.value)}
          autocomplete="current-password"
          required
        />
      </label>

      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? 'Unlocking...' : 'Unlock'}
      </button>

      <button type="button" class="linkish" onClick={onForgot}>
        I forgot my passphrase
      </button>
    </form>
  );
}
