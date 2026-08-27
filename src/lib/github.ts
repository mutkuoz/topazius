import { isReservedPath } from './paths';

const API = 'https://api.github.com';

export interface GitHubErrorDetails {
  /** From the x-ratelimit-remaining response header, when present. */
  rateLimitRemaining?: number;
  /** From the Retry-After response header (seconds), when present. */
  retryAfter?: number;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly rateLimitRemaining?: number;
  readonly retryAfter?: number;

  constructor(status: number, message: string, details?: GitHubErrorDetails) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimitRemaining = details?.rateLimitRemaining;
    this.retryAfter = details?.retryAfter;
  }
}

export interface RepoInfo {
  defaultBranch: string;
  canPush: boolean;
  isPrivate: boolean;
  /** Classic PATs carry account-wide scope; the UI warns about them. */
  tokenIsClassic: boolean;
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface GitHubClientOptions {
  /** A getter, not a value: the token is read per request and never stored here. */
  token: () => string;
  owner: string;
  repo: string;
}

export interface GitHubClient {
  getRepo(): Promise<RepoInfo>;
  getTree(branch: string): Promise<TreeEntry[]>;
  getBlob(sha: string): Promise<Uint8Array<ArrayBuffer>>;
}

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64.replace(/\s/g, ''));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseHeaderInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function createClient(options: GitHubClientOptions): GitHubClient {
  const base = `${API}/repos/${options.owner}/${options.repo}`;

  async function request(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${options.token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      // The thrown TypeError can echo the request; never re-expose it.
      throw new GitHubError(0, 'Could not reach GitHub. Check your connection.');
    }

    if (!response.ok) {
      // Only GitHub's own message is surfaced - never headers, never the URL.
      const message = await response
        .json()
        .then((b: unknown) => (b as { message?: string })?.message)
        .catch(() => undefined);
      throw new GitHubError(response.status, message ?? `GitHub returned ${response.status}.`, {
        rateLimitRemaining: parseHeaderInt(response.headers.get('x-ratelimit-remaining')),
        retryAfter: parseHeaderInt(response.headers.get('retry-after')),
      });
    }

    return response;
  }

  async function readTree(ref: string, recursive: boolean) {
    // encodeURIComponent(ref) as a whole would percent-encode the slashes in
    // a branch name like 'feat/x' to 'feat%2Fx', which the trees endpoint
    // does not resolve. Encode each path segment individually and rejoin so
    // the slashes survive as real separators.
    const encodedRef = ref.split('/').map(encodeURIComponent).join('/');
    const url = `${base}/git/trees/${encodedRef}${recursive ? '?recursive=1' : ''}`;
    return (await request(url)).json() as Promise<{
      truncated: boolean;
      tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    }>;
  }

  /**
   * Very large vaults truncate the recursive tree; fall back to a sequential
   * depth-first walk, one directory fetched at a time.
   */
  async function walk(ref: string, prefix: string): Promise<TreeEntry[]> {
    const { tree } = await readTree(ref, false);
    const entries: TreeEntry[] = [];

    for (const node of tree) {
      const path = prefix ? `${prefix}/${node.path}` : node.path;
      if (node.type === 'blob') {
        entries.push({ path, sha: node.sha, size: node.size ?? 0 });
      } else if (node.type === 'tree') {
        // assets/ and .topazius/ are reserved and hidden from the note
        // tree (sync.ts filters them too); skip descending into them here
        // so a large assets/ folder doesn't cost extra requests for
        // nothing.
        if (isReservedPath(`${path}/`)) continue;
        entries.push(...(await walk(node.sha, path)));
      }
    }

    return entries;
  }

  return {
    async getRepo() {
      const response = await request(base);
      const body = (await response.json()) as {
        default_branch: string;
        private: boolean;
        permissions?: { push?: boolean };
      };
      return {
        defaultBranch: body.default_branch,
        canPush: body.permissions?.push === true,
        isPrivate: body.private,
        tokenIsClassic: response.headers.get('x-oauth-scopes') !== null,
      };
    },

    async getTree(branch) {
      const recursive = await readTree(branch, true);
      if (!recursive.truncated) {
        return recursive.tree
          .filter((n) => n.type === 'blob')
          .map((n) => ({ path: n.path, sha: n.sha, size: n.size ?? 0 }));
      }
      return walk(branch, '');
    },

    async getBlob(sha) {
      const body = (await (await request(`${base}/git/blobs/${sha}`)).json()) as {
        content: string;
        encoding: string;
      };
      if (body.encoding !== 'base64') {
        throw new GitHubError(0, `Unexpected blob encoding "${body.encoding}".`);
      }
      return base64ToBytes(body.content);
    },
  };
}
