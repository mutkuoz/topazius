import { describe, expect, it, vi } from 'vitest';
import { CACHE_PREFIX, isApiRequest, routeFor, staleCaches } from '../src/sw/policy';
import { type FetchEventLike, type LifecycleEventLike, attach } from '../src/sw/worker';

const ORIGIN = 'https://me.github.io';
const precached = new Set(['/topazius/index.html', '/topazius/assets/index-abc123.js']);

const route = (url: string, overrides: Partial<Parameters<typeof routeFor>[0]> = {}) =>
  routeFor({ url, origin: ORIGIN, method: 'GET', mode: 'no-cors', precached, ...overrides });

describe('never caching the API (spec §10.3)', () => {
  it('recognises an API request', () => {
    expect(isApiRequest('https://api.github.com/repos/me/my-notes')).toBe(true);
    expect(isApiRequest('https://api.github.com/repos/me/my-notes/git/blobs/abc')).toBe(true);
    expect(isApiRequest('https://me.github.io/topazius/index.html')).toBe(false);
    expect(isApiRequest('not a url')).toBe(false);
  });

  it('routes every API request to the network, whatever it looks like', () => {
    expect(route('https://api.github.com/repos/me/my-notes')).toBe('network');
    expect(route('https://api.github.com/repos/me/my-notes', { mode: 'navigate' })).toBe('network');
    expect(route('https://api.github.com/x', { method: 'PUT' })).toBe('network');
  });

  it('leaves every other origin alone too', () => {
    expect(route('https://raw.githubusercontent.com/me/my-notes/main/a.md')).toBe('network');
    expect(route('https://example.com/tracker.js')).toBe('network');
  });


});

describe('app shell routing', () => {
  it('serves navigations from the cached shell', () => {
    expect(route(`${ORIGIN}/topazius/`, { mode: 'navigate' })).toBe('shell');
    expect(route(`${ORIGIN}/topazius/deep/link`, { mode: 'navigate' })).toBe('shell');
  });

  it('serves precached assets from the cache first', () => {
    expect(route(`${ORIGIN}/topazius/assets/index-abc123.js`)).toBe('cache-first');
  });

  it('sends anything same-origin it did not precache to the network', () => {
    expect(route(`${ORIGIN}/topazius/assets/not-precached.js`)).toBe('network');
  });

  it('never intercepts a non-GET request', () => {
    expect(route(`${ORIGIN}/topazius/index.html`, { method: 'POST' })).toBe('network');
  });

  it('ignores a query string when matching the precache', () => {
    expect(route(`${ORIGIN}/topazius/assets/index-abc123.js?v=2`)).toBe('cache-first');
  });
});

describe('cache housekeeping', () => {
  it('deletes this app’s older caches and nothing else', () => {
    const names = [`${CACHE_PREFIX}old`, `${CACHE_PREFIX}current`, 'some-other-app'];
    expect(staleCaches(names, `${CACHE_PREFIX}current`)).toEqual([`${CACHE_PREFIX}old`]);
  });
});

/**
 * The worker itself, driven against fake globals. A policy module that were
 * correct but unwired would pass every test above this one.
 */
function harness(precache = ['/topazius/index.html', '/topazius/assets/index-abc123.js']) {
  const listeners = new Map<string, (event: never) => void>();
  const store = new Map<string, Response>();
  const deleted: string[] = [];
  const cache = {
    addAll: vi.fn(async (requests: Request[]) => {
      for (const request of requests) store.set(new URL(request.url).pathname, new Response('cached'));
    }),
    put: vi.fn(async (url: string, response: Response) => {
      store.set(new URL(url).pathname, response);
    }),
  };

  const caches = {
    open: vi.fn(async () => cache),
    match: vi.fn(async (url: string) => store.get(new URL(url, ORIGIN).pathname)),
    keys: vi.fn(async () => [`${CACHE_PREFIX}old`, 'another-app']),
    delete: vi.fn(async (name: string) => {
      deleted.push(name);
      return true;
    }),
  } as unknown as CacheStorage;

  const fetched: string[] = [];
  const scope = {
    addEventListener: (type: string, listener: (event: never) => void) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
    location: { href: `${ORIGIN}/topazius/`, origin: ORIGIN },
  };

  attach({
    scope,
    caches,
    precache,
    version: 'current',
    fetch: async (request) => {
      fetched.push(typeof request === 'string' ? request : request.url);
      return new Response('from network');
    },
  });

  async function dispatch(type: 'install' | 'activate') {
    const work: Promise<unknown>[] = [];
    const event: LifecycleEventLike = { waitUntil: (promise) => work.push(promise) };
    listeners.get(type)?.(event as never);
    await Promise.all(work);
  }

  async function request(url: string, init: { method?: string; mode?: string } = {}) {
    // Collected in an array rather than a variable: TypeScript's control-flow
    // analysis cannot see an assignment made inside a callback, and would
    // narrow a `let` to null.
    const responses: Promise<Response>[] = [];
    const event: FetchEventLike = {
      request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'no-cors' },
      respondWith: (response) => responses.push(response),
    };
    listeners.get('fetch')?.(event as never);
    const [responded] = responses;
    return { handled: responded !== undefined, response: responded ? await responded : null };
  }

  return { dispatch, request, cache, caches, store, deleted, fetched, scope };
}

describe('the worker itself', () => {
  it('precaches the shell on install', async () => {
    const worker = harness();
    await worker.dispatch('install');

    expect(worker.cache.addAll).toHaveBeenCalledOnce();
    expect(worker.store.has('/topazius/index.html')).toBe(true);
    expect(worker.scope.skipWaiting).toHaveBeenCalled();
  });

  it('drops this app’s older caches on activate, and no one else’s', async () => {
    const worker = harness();
    await worker.dispatch('activate');
    expect(worker.deleted).toEqual([`${CACHE_PREFIX}old`]);
  });

  it('does not so much as look at an API request', async () => {
    const worker = harness();
    await worker.dispatch('install');

    const result = await worker.request('https://api.github.com/repos/me/my-notes/git/blobs/abc');

    // Not handled at all: no respondWith, so no cache read, no cache write,
    // and no chance of a note ending up on disk in the clear (spec §10.3).
    expect(result.handled).toBe(false);
    expect(worker.cache.put).not.toHaveBeenCalled();
    expect(worker.caches.match).not.toHaveBeenCalled();
  });

  it('serves a navigation from the cached shell, even offline', async () => {
    const worker = harness();
    await worker.dispatch('install');

    const result = await worker.request(`${ORIGIN}/topazius/some/deep/link`, { mode: 'navigate' });

    expect(result.handled).toBe(true);
    expect(await result.response?.text()).toBe('cached');
    expect(worker.fetched).toEqual([]);
  });

  it('serves a precached asset from the cache', async () => {
    const worker = harness();
    await worker.dispatch('install');

    const result = await worker.request(`${ORIGIN}/topazius/assets/index-abc123.js`);

    expect(await result.response?.text()).toBe('cached');
    expect(worker.fetched).toEqual([]);
  });

  it('falls back to the network, and caches what it fetches, for a precached path that is missing', async () => {
    const worker = harness();
    // No install: the cache is empty, so the asset has to be fetched.
    const result = await worker.request(`${ORIGIN}/topazius/assets/index-abc123.js`);

    expect(await result.response?.text()).toBe('from network');
    expect(worker.fetched).toEqual([`${ORIGIN}/topazius/assets/index-abc123.js`]);
    expect(worker.cache.put).toHaveBeenCalled();
  });

  it('leaves a same-origin path it never precached to the browser', async () => {
    const worker = harness();
    await worker.dispatch('install');

    const result = await worker.request(`${ORIGIN}/topazius/whatever.json`);
    expect(result.handled).toBe(false);
  });
});
