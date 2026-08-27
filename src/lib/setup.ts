import { GitHubError, createClient } from './github';

export interface SetupInput {
  owner: string;
  repo: string;
  token: string;
}

export interface SetupResult {
  branch: string;
  warnings: string[];
}

const IDENTIFIER_RE = /^[A-Za-z0-9._-]+$/;

/**
 * owner and repo are interpolated, unvalidated, straight into the request
 * URL github.ts builds for every call this token ever makes. `..` collapses
 * the path onto a different endpoint; `?`/`#` truncate it. The CSP pins the
 * host so this cannot exfiltrate the token, but it is still unvalidated
 * input sitting next to a credential, so reject it here before it ever
 * reaches github.ts.
 */
function validateIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`${label} may only contain letters, digits, ".", "_", and "-".`);
  }
  // "." and ".." satisfy the character class above but are exactly the
  // dot-segments that collapse the request path when the browser's URL
  // parser normalises them ("/repos/../my-notes" resolves to "/my-notes"
  // before the request is sent) - the case the brief's regex alone does not
  // stop, so reject them explicitly, matching paths.ts's own "." / ".."
  // check for note paths.
  if (value === '.' || value === '..') {
    throw new Error(`${label} may not be "." or "..".`);
  }
  if (label === 'Repository owner' && value.startsWith('-')) {
    throw new Error('Repository owner may not start with "-".');
  }
}

/** Check the token really reaches the repo, and report anything the user should know. */
export async function validateSetup(input: SetupInput): Promise<SetupResult> {
  validateIdentifier(input.owner, 'Repository owner');
  validateIdentifier(input.repo, 'Repository name');

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
