import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type GitHubError, base64ToBytes, bytesToBase64, createClient } from '../src/lib/github';

const TOKEN = 'github_pat_11ABCDEF_supersecretvalue';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = () => createClient({ token: () => TOKEN, owner: 'me', repo: 'my-notes' });

describe('base64 helpers', () => {
  it('round-trip arbitrary bytes', () => {
    const bytes = new Uint8Array(1024).map((_, i) => i % 256);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('handle payloads far larger than the argument limit of String.fromCharCode', () => {
    const bytes = new Uint8Array(500_000).fill(65);
    expect(base64ToBytes(bytesToBase64(bytes))).toHaveLength(500_000);
  });

  it('round-trip multi-byte UTF-8 note content', () => {
    const source = '# Baslik\n\nemoji and accents: café 🎉\n';
    const bytes = new TextEncoder().encode(source);
    expect(new TextDecoder().decode(base64ToBytes(bytesToBase64(bytes)))).toBe(source);
  });
});

describe('getRepo', () => {
  it('reports the default branch, push permission, and privacy', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json({ default_branch: 'trunk', private: true, permissions: { push: true } }),
      ),
    );

    expect(await client().getRepo()).toEqual({
      defaultBranch: 'trunk',
      canPush: true,
      isPrivate: true,
      tokenIsClassic: false,
    });
  });

  it('flags a classic PAT via the X-OAuth-Scopes header', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json(
          { default_branch: 'main', private: true, permissions: { push: true } },
          { headers: { 'X-OAuth-Scopes': 'repo, gist' } },
        ),
      ),
    );

    expect((await client().getRepo()).tokenIsClassic).toBe(true);
  });

  it('sends the token as a bearer credential', async () => {
    let seen: string | null = null;
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', ({ request }) => {
        seen = request.headers.get('authorization');
        return HttpResponse.json({ default_branch: 'main', private: true, permissions: { push: true } });
      }),
    );

    await client().getRepo();
    expect(seen).toBe(`Bearer ${TOKEN}`);
  });
});

describe('error handling', () => {
  it('throws GitHubError carrying the status', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );

    await expect(client().getRepo()).rejects.toMatchObject({ status: 401 });
  });

  it('never leaks the token into the error it throws', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );

    const error = (await client()
      .getRepo()
      .catch((e: unknown) => e)) as GitHubError;
    const serialised = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`;
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('supersecret');
  });

  it('carries rate-limit details from the response headers, when present', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json(
          { message: 'API rate limit exceeded' },
          { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' } },
        ),
      ),
    );

    const error = (await client()
      .getRepo()
      .catch((e: unknown) => e)) as GitHubError;
    expect(error.rateLimitRemaining).toBe(0);
    expect(error.retryAfter).toBe(30);
  });

  it('leaves rate-limit details undefined when the headers are absent', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );

    const error = (await client()
      .getRepo()
      .catch((e: unknown) => e)) as GitHubError;
    expect(error.rateLimitRemaining).toBeUndefined();
    expect(error.retryAfter).toBeUndefined();
  });
});

describe('getTree', () => {
  it('returns blob entries and drops directories', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/trees/main', () =>
        HttpResponse.json({
          truncated: false,
          tree: [
            { path: 'work', type: 'tree', sha: 'dir' },
            { path: 'work/a.md', type: 'blob', sha: 'sha-a', size: 10 },
            { path: 'recipes/b.md', type: 'blob', sha: 'sha-b', size: 20 },
          ],
        }),
      ),
    );

    expect(await client().getTree('main')).toEqual([
      { path: 'work/a.md', sha: 'sha-a', size: 10 },
      { path: 'recipes/b.md', sha: 'sha-b', size: 20 },
    ]);
  });

  it('walks per-directory when the recursive tree is truncated', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/trees/:ref', ({ params, request }) => {
        const recursive = new URL(request.url).searchParams.get('recursive');
        if (params.ref === 'main' && recursive) {
          return HttpResponse.json({ truncated: true, tree: [] });
        }
        if (params.ref === 'main') {
          return HttpResponse.json({
            truncated: false,
            tree: [
              { path: 'root.md', type: 'blob', sha: 'sha-root', size: 1 },
              { path: 'work', type: 'tree', sha: 'sha-work' },
            ],
          });
        }
        return HttpResponse.json({
          truncated: false,
          tree: [{ path: 'nested.md', type: 'blob', sha: 'sha-nested', size: 2 }],
        });
      }),
    );

    expect((await client().getTree('main')).map((e) => e.path).sort()).toEqual([
      'root.md',
      'work/nested.md',
    ]);
  });

  it('skips reserved directories during the fallback walk, never fetching them', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/trees/:ref', ({ params, request }) => {
        const recursive = new URL(request.url).searchParams.get('recursive');
        if (params.ref === 'main' && recursive) {
          return HttpResponse.json({ truncated: true, tree: [] });
        }
        if (params.ref === 'main') {
          return HttpResponse.json({
            truncated: false,
            tree: [
              { path: 'root.md', type: 'blob', sha: 'sha-root', size: 1 },
              { path: 'work', type: 'tree', sha: 'sha-work' },
              { path: 'assets', type: 'tree', sha: 'sha-assets' },
              { path: '.topazius', type: 'tree', sha: 'sha-topazius' },
            ],
          });
        }
        if (params.ref === 'sha-work') {
          return HttpResponse.json({
            truncated: false,
            tree: [{ path: 'nested.md', type: 'blob', sha: 'sha-nested', size: 2 }],
          });
        }
        // No handler registered for sha-assets or sha-topazius: if walk()
        // ever descends into them, onUnhandledRequest: 'error' (see
        // beforeAll) fails this test loudly.
        throw new Error(`unexpected tree fetch for ref ${String(params.ref)}`);
      }),
    );

    expect((await client().getTree('main')).map((e) => e.path).sort()).toEqual([
      'root.md',
      'work/nested.md',
    ]);
  });

  it('encodes a branch containing a slash per path segment, so it still resolves', async () => {
    // encodeURIComponent('feat/x') as a whole would produce 'feat%2Fx', which
    // the trees endpoint does not resolve. A literal handler at the
    // slash-preserving path is only reachable if each segment is encoded on
    // its own; onUnhandledRequest: 'error' fails loudly if the old
    // whole-ref encoding regresses.
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/trees/feat/x', () =>
        HttpResponse.json({
          truncated: false,
          tree: [{ path: 'a.md', type: 'blob', sha: 'sha-a', size: 1 }],
        }),
      ),
    );

    expect(await client().getTree('feat/x')).toEqual([{ path: 'a.md', sha: 'sha-a', size: 1 }]);
  });
});

describe('getBlob', () => {
  it('decodes base64 blob content', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/blobs/sha-a', () =>
        HttpResponse.json({ encoding: 'base64', content: bytesToBase64(new TextEncoder().encode('hi')) }),
      ),
    );

    expect(new TextDecoder().decode(await client().getBlob('sha-a'))).toBe('hi');
  });

  it('tolerates the newlines GitHub wraps base64 in', async () => {
    const wrapped = bytesToBase64(new TextEncoder().encode('x'.repeat(200))).replace(/(.{60})/g, '$1\n');
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/blobs/sha-w', () =>
        HttpResponse.json({ encoding: 'base64', content: wrapped }),
      ),
    );

    expect(await client().getBlob('sha-w')).toHaveLength(200);
  });
});
