import type { IDBPDatabase } from 'idb';
import { useRef, useState } from 'preact/hooks';
import { type TopaziusDB, writeConfig } from '../lib/db';
import { MIN_PASSPHRASE_LENGTH, type Session } from '../lib/session';
import { validateSetup } from '../lib/setup';
import './forms.css';

const TOKEN_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens/new';

type PassphraseStrength = 'weak' | 'fair' | 'strong';

const STRENGTH_LABEL: Record<PassphraseStrength, string> = {
  weak: 'Weak',
  fair: 'Fair',
  strong: 'Strong',
};

/**
 * Length-weighted, dependency-free strength estimate: length matters more
 * than character-class variety (a long plain passphrase beats a short
 * complex one), but variety still helps. Purely advisory - see
 * MIN_PASSPHRASE_LENGTH for the one hard gate on submission.
 */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(passphrase)).length;
  const points = passphrase.length + classes * 4;
  if (points >= 34) return 'strong';
  if (points >= 20) return 'fair';
  return 'weak';
}

export interface SetupProps {
  db: IDBPDatabase<TopaziusDB>;
  session: Session;
  onDone: () => void;
}

/** A validated setup awaiting the user's acknowledgement of its warnings before it is persisted. */
interface PendingSetup {
  owner: string;
  repo: string;
  token: string;
  branch: string;
  passphrase: string;
}

export function Setup({ db, session, onDone }: SetupProps) {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSetup | null>(null);
  // Bumped by resetValidation() so an edit made while a submit() is in flight can
  // supersede it: submit() captures the generation before awaiting validateSetup and
  // refuses to act on a stale result once it resolves.
  const generation = useRef(0);

  async function persist(input: PendingSetup) {
    await writeConfig(db, {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      prefs: {},
    });
    await session.enroll(input.token, input.passphrase);
    onDone();
  }

  /** Any edit invalidates a pending, not-yet-persisted validation: only what is currently in the form may be enrolled. */
  function resetValidation() {
    generation.current++;
    setError(null);
    setWarnings([]);
    setPending(null);
  }

  async function submit(event: Event) {
    event.preventDefault();
    resetValidation();
    const mine = generation.current;

    if (passphrase !== confirm) {
      setError('The two passphrases do not match.');
      return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      const trimmed = { owner: owner.trim(), repo: repo.trim(), token: token.trim() };
      const result = await validateSetup(trimmed);
      // The form was edited while this validation was in flight: its result no longer
      // describes what is on screen, so it must not become pending or persist.
      if (mine !== generation.current) return;
      if (result.warnings.length === 0) {
        await persist({ ...trimmed, branch: result.branch, passphrase });
      } else {
        setWarnings(result.warnings);
        setPending({ ...trimmed, branch: result.branch, passphrase });
      }
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge() {
    if (!pending || busy) return;
    setError(null);
    setBusy(true);
    try {
      await persist(pending);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="panel" onSubmit={submit}>
      <h1>Connect your vault</h1>
      <p>
        Your notes live in a private GitHub repository that you own. Topazius talks to it directly from
        this browser, and sends them nowhere else.
      </p>

      <label>
        Repository owner
        <input
          value={owner}
          onInput={(e) => {
            setOwner(e.currentTarget.value);
            resetValidation();
          }}
          autocomplete="off"
          required
        />
      </label>

      <label>
        Repository name
        <input
          value={repo}
          onInput={(e) => {
            setRepo(e.currentTarget.value);
            resetValidation();
          }}
          autocomplete="off"
          required
        />
      </label>

      <label>
        Access token
        <input
          type="password"
          value={token}
          onInput={(e) => {
            setToken(e.currentTarget.value);
            resetValidation();
          }}
          autocomplete="off"
          spellcheck={false}
          required
        />
      </label>
      <p class="hint">
        Create a <strong>fine-grained</strong> token at{' '}
        <a href={TOKEN_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
          github.com/settings/personal-access-tokens
        </a>
        , limited to this one repository, with <strong>Contents: Read and write</strong>. Nothing else is
        needed.
      </p>

      <label>
        Passphrase
        <input
          type="password"
          value={passphrase}
          onInput={(e) => {
            setPassphrase(e.currentTarget.value);
            resetValidation();
          }}
          autocomplete="new-password"
          aria-describedby="passphrase-strength"
          required
        />
      </label>
      {passphrase.length > 0 && (
        <p id="passphrase-strength" class={`hint strength-${passphraseStrength(passphrase)}`}>
          Passphrase strength: {STRENGTH_LABEL[passphraseStrength(passphrase)]}
        </p>
      )}

      <label>
        Confirm passphrase
        <input
          type="password"
          value={confirm}
          onInput={(e) => {
            setConfirm(e.currentTarget.value);
            resetValidation();
          }}
          autocomplete="new-password"
          required
        />
      </label>
      <p class="hint">
        Your token is encrypted with this passphrase and stored only on this device. It{' '}
        <strong>cannot be recovered</strong>: if you forget it, you will enter a new token and choose a new
        passphrase. Your notes stay safe in GitHub either way.
      </p>

      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      {warnings.map((warning) => (
        <p class="warn" key={warning}>
          {warning}
        </p>
      ))}

      {pending ? (
        <button type="button" class="ack" onClick={acknowledge} disabled={busy}>
          {busy ? 'Saving...' : 'I understand — continue'}
        </button>
      ) : (
        <button type="submit" disabled={busy}>
          {busy ? 'Checking...' : 'Unlock vault'}
        </button>
      )}
    </form>
  );
}
