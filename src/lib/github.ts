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

/** A file read back from the Contents API, with the blob sha a write must quote. */
export interface FileContent {
  sha: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface PutFileInput {
  path: string;
  bytes: Uint8Array;
  message: string;
  branch: string;
  /** The sha this write is based on. Omitted for a create; a mismatch is a 409. */
  sha?: string;
}

export interface DeleteFileInput {
  path: string;
  sha: string;
  message: string;
  branch: string;
}

export interface WriteResult {
  sha: string;
  size: number;
}

export interface GitHubClient {
  getRepo(): Promise<RepoInfo>;
  getTree(branch: string): Promise<TreeEntry[]>;
  getBlob(sha: string): Promise<Uint8Array<ArrayBuffer>>;
  /** null when the file is absent - a 404 here is an answer, not a failure. */
  getFile(path: string, ref: string): Promise<FileContent | null>;
  putFile(input: PutFileInput): Promise<WriteResult>;
  /** Resolves on a 404: something else already deleted it, which is the desired state. */
  deleteFile(input: DeleteFileInput): Promise<void>;
}

/**
 * Percent-encode a path for a URL without destroying its separators.
 * encodeURIComponent() on the whole path would turn every "/" into "%2F",
 * which the Contents API does not resolve back into directories.
 */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
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

  async function request(url: string, init?: { method: string; body: unknown }): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${options.token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init ? { body: JSON.stringify(init.body) } : {}),
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
    // does not resolve. encodePath() keeps them as real separators.
    const url = `${base}/git/trees/${encodePath(ref)}${recursive ? '?recursive=1' : ''}`;
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
        // .topazius/ holds one small file that sync.ts fetches by name; there
        // is nothing to discover by walking it. assets/ *is* walked, because
        // the image resolver needs to know which assets exist - skipping it
        // here would leave images unresolvable in exactly the vaults large
        // enough to truncate the recursive tree.
        if (path === '.topazius' || path.startsWith('.topazius/')) continue;
        entries.push(...(await walk(node.sha, path)));
      }
    }

    return entries;
  }

  async function getBlob(sha: string): Promise<Uint8Array<ArrayBuffer>> {
    const body = (await (await request(`${base}/git/blobs/${sha}`)).json()) as {
      content: string;
      encoding: string;
    };
    if (body.encoding !== 'base64') {
      throw new GitHubError(0, `Unexpected blob encoding "${body.encoding}".`);
    }
    return base64ToBytes(body.content);
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

    getBlob,

    async getFile(path, ref) {
      let response: Response;
      try {
        response = await request(
          `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        );
      } catch (error) {
        // Absent is an answer here, not a failure: callers use this to ask
        // "what is on the remote right now?", and "nothing" is a valid reply.
        if (error instanceof GitHubError && error.status === 404) return null;
        throw error;
      }

      const body = (await response.json()) as { sha: string; encoding?: string; content?: string };
      // Above ~1MB the Contents API answers with the metadata and an empty
      // body ("encoding": "none"); the blob endpoint still serves it.
      if (body.encoding !== 'base64') {
        return { sha: body.sha, bytes: await getBlob(body.sha) };
      }
      return { sha: body.sha, bytes: base64ToBytes(body.content ?? '') };
    },

    async putFile(input) {
      const response = await request(`${base}/contents/${encodePath(input.path)}`, {
        method: 'PUT',
        body: {
          message: input.message,
          content: bytesToBase64(input.bytes),
          branch: input.branch,
          // Present only for an update: sending `sha: undefined` would be
          // dropped by JSON.stringify anyway, but sending sha: "" is a 422.
          ...(input.sha ? { sha: input.sha } : {}),
        },
      });
      const body = (await response.json()) as { content?: { sha?: string; size?: number } };
      return { sha: body.content?.sha ?? '', size: body.content?.size ?? input.bytes.length };
    },

    async deleteFile(input) {
      try {
        await request(`${base}/contents/${encodePath(input.path)}`, {
          method: 'DELETE',
          body: { message: input.message, branch: input.branch, sha: input.sha },
        });
      } catch (error) {
        // Already gone is the outcome this asked for.
        if (error instanceof GitHubError && error.status === 404) return;
        throw error;
      }
    },
  };
}
