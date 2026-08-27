import type { IDBPDatabase } from 'idb';
import { useState } from 'preact/hooks';
import { type TopaziusDB, writeConfig } from '../lib/db';
import { GitHubError, createClient } from '../lib/github';
import { MIN_PASSPHRASE_LENGTH, type Session } from '../lib/session';
import './forms.css';

const TOKEN_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens/new';

export interface SetupInput {
  owner: string;
  repo: string;
  token: string;
}

export interface SetupResult {
  branch: string;
  warnings: string[];
}

/** Check the token really reaches the repo, and report anything the user should know. */
export async function validateSetup(input: SetupInput): Promise<SetupResult> {
  const gh = createClient({ token: () => input.token, owner: input.owner, repo: input.repo });

  let info;
  try {
    info = await gh.getRepo();
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new Error(
        'Could not find that repository. Check the name, and check that the token grants access to it.',
      );
    }
    if (error instanceof GitHubError && error.status === 401) {
      throw new Error('GitHub rejected that token. It may be expired or mistyped.');
    }
    throw error;
  }

  if (!info.canPush) {
    throw new Error(
      'That token can read the repository but cannot write to it. Grant Contents: Read and write.',
    );
  }

  const warnings: string[] = [];
  if (info.tokenIsClassic) {
    warnings.push(
      'That is a classic token, which can reach every repository in your account. A fine-grained token scoped to this one repository is safer.',
    );
  }
  if (!info.isPrivate) {
    warnings.push('This repository is public, so anyone can read your notes. Consider making it private.');
  }

  return { branch: info.defaultBranch, warnings };
}

export interface SetupProps {
  db: IDBPDatabase<TopaziusDB>;
  session: Session;
  onDone: () => void;
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

  async function submit(event: Event) {
    event.preventDefault();
    setError(null);
    setWarnings([]);

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
      await writeConfig(db, {
        owner: trimmed.owner,
        repo: trimmed.repo,
        branch: result.branch,
        prefs: {},
      });
      await session.enroll(trimmed.token, passphrase);
      setWarnings(result.warnings);
      onDone();
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
        <input value={owner} onInput={(e) => setOwner(e.currentTarget.value)} autocomplete="off" required />
      </label>

      <label>
        Repository name
        <input value={repo} onInput={(e) => setRepo(e.currentTarget.value)} autocomplete="off" required />
      </label>

      <label>
        Access token
        <input
          type="password"
          value={token}
          onInput={(e) => setToken(e.currentTarget.value)}
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
          onInput={(e) => setPassphrase(e.currentTarget.value)}
          autocomplete="new-password"
          required
        />
      </label>

      <label>
        Confirm passphrase
        <input
          type="password"
          value={confirm}
          onInput={(e) => setConfirm(e.currentTarget.value)}
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

      <button type="submit" disabled={busy}>
        {busy ? 'Checking...' : 'Unlock vault'}
      </button>
    </form>
  );
}
