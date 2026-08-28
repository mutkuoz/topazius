import { useState } from 'preact/hooks';
import { MIN_PASSPHRASE_LENGTH } from '../lib/session';
import { Dialog } from './Dialog';

/**
 * What an attacker with repository access can still see, spelled out the first
 * time a note is sealed (spec §9.6). It is a short table on purpose: the point
 * is that it gets read.
 */
function LeakageTable() {
  return (
    <table class="leakage">
      <caption>What stays visible to anyone who can read the repository</caption>
      <thead>
        <tr>
          <th scope="col">Visible</th>
          <th scope="col">Hidden</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>File and folder names</td>
          <td rowSpan={4}>Everything inside an encrypted note: title, tags, links, body</td>
        </tr>
        <tr>
          <td>Which notes are encrypted, and how many</td>
        </tr>
        <tr>
          <td>Roughly how large each note is</td>
        </tr>
        <tr>
          <td>Commit timestamps, so edit frequency</td>
        </tr>
      </tbody>
    </table>
  );
}

export interface SetupEncryptionProps {
  /** Runs the ceremony and returns the recovery key to display exactly once. */
  onCreate: (passphrase: string) => Promise<string>;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * The first-encryption ceremony (spec §9.3). The recovery key is mandatory and
 * shown once; without it, "forgetting your passphrase costs only the token"
 * silently becomes "forgetting your passphrase destroys your notes".
 */
export function SetupEncryption({ onCreate, onDone, onCancel }: SetupEncryptionProps) {
  const [passphrase, setPassphrase] = useState('');
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: Event) {
    event.preventDefault();
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setRecoveryKey(await onCreate(passphrase));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not set up encryption.');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryKey === null) {
    return (
      <Dialog title="Encrypt this note" onClose={onCancel}>
        <form onSubmit={create} class="stack">
          <p>
            Encrypting a note seals its contents so that <strong>not even GitHub can read it</strong>. It
            is stored as a <code>.md.enc</code> file, which Obsidian and <code>git diff</code> cannot
            read either — the cost of the protection, paid only on the notes you choose.
          </p>
          <LeakageTable />
          <p class="hint">
            Keep sensitive detail out of filenames: <code>journal/2026-08-27.md.enc</code>, not{' '}
            <code>journal/therapy-session.md.enc</code>.
          </p>
          <label>
            Confirm your passphrase
            <input
              type="password"
              value={passphrase}
              onInput={(event) => {
                setPassphrase(event.currentTarget.value);
                setError(null);
              }}
              autocomplete="current-password"
              required
            />
          </label>
          <p class="hint">
            The same passphrase you unlock with. It wraps the vault key, which is what actually
            encrypts your notes.
          </p>
          {error && (
            <p class="alert" role="alert">
              {error}
            </p>
          )}
          <div class="row">
            <button type="submit" disabled={busy}>
              {busy ? 'Setting up…' : 'Set up encryption'}
            </button>
            <button type="button" class="secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title="Save your recovery key" onClose={onCancel} insistent>
      <p>
        This is the only way back into your encrypted notes if you forget your passphrase. It is shown{' '}
        <strong>once</strong>. Write it down or put it in a password manager now.
      </p>
      <p class="recovery-key">
        <code>{recoveryKey}</code>
      </p>
      <button
        type="button"
        class="secondary"
        onClick={() => void navigator.clipboard?.writeText(recoveryKey).catch(() => undefined)}
      >
        Copy to clipboard
      </button>
      <label class="checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />
        I have stored this recovery key somewhere safe.
      </label>
      <div class="row">
        <button type="button" disabled={!confirmed} onClick={onDone}>
          Continue
        </button>
      </div>
    </Dialog>
  );
}

export interface UnlockVaultKeyProps {
  onUnlock: (secret: string, which: 'passphrase' | 'recovery') => Promise<void>;
  onClose: () => void;
}

/** Asked for when a device meets sealed notes it has no key for (spec §9.2). */
export function UnlockVaultKey({ onUnlock, onClose }: UnlockVaultKeyProps) {
  const [secret, setSecret] = useState('');
  const [which, setWhich] = useState<'passphrase' | 'recovery'>('passphrase');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onUnlock(secret, which);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not open the vault.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Unlock encrypted notes" onClose={onClose}>
      <form onSubmit={submit} class="stack">
        <p>
          This vault has encrypted notes. Enter your passphrase, or the recovery key you saved when
          encryption was set up.
        </p>
        <div class="row">
          <button
            type="button"
            class={which === 'passphrase' ? '' : 'secondary'}
            aria-pressed={which === 'passphrase'}
            onClick={() => setWhich('passphrase')}
          >
            Passphrase
          </button>
          <button
            type="button"
            class={which === 'recovery' ? '' : 'secondary'}
            aria-pressed={which === 'recovery'}
            onClick={() => setWhich('recovery')}
          >
            Recovery key
          </button>
        </div>
        <label>
          {which === 'passphrase' ? 'Passphrase' : 'Recovery key'}
          <input
            type={which === 'passphrase' ? 'password' : 'text'}
            value={secret}
            onInput={(event) => {
              setSecret(event.currentTarget.value);
              setError(null);
            }}
            autocomplete={which === 'passphrase' ? 'current-password' : 'off'}
            spellcheck={false}
            required
          />
        </label>
        {error && (
          <p class="alert" role="alert">
            {error}
          </p>
        )}
        <div class="row">
          <button type="submit" disabled={busy}>
            {busy ? 'Opening…' : 'Unlock'}
          </button>
          <button type="button" class="secondary" onClick={onClose}>
            Not now
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export interface RecoveryKeyShownProps {
  recoveryKey: string;
  onClose: () => void;
}

/** Shown after regenerating: the previous key stopped working the moment this appeared. */
export function RecoveryKeyShown({ recoveryKey, onClose }: RecoveryKeyShownProps) {
  return (
    <Dialog title="Your new recovery key" onClose={onClose} insistent>
      <p>
        The previous recovery key no longer works. This one is shown <strong>once</strong>.
      </p>
      <p class="recovery-key">
        <code>{recoveryKey}</code>
      </p>
      <div class="row">
        <button type="button" onClick={onClose}>
          I have saved it
        </button>
      </div>
    </Dialog>
  );
}
