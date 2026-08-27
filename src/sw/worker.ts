import { CACHE_PREFIX, routeFor, staleCaches } from './policy';

/**
 * The app-shell service worker's behaviour (spec §10.3), as a function of the
 * globals it runs against rather than of the globals themselves.
 *
 * Written this way so the one rule that must never regress - API responses are
 * never cached, because that would write plaintext note content to disk
 * outside the encrypted store - is exercised by a test that drives the real
 * fetch handler, not by reading the source and hoping.
 */

/** The parts of ServiceWorkerGlobalScope this worker uses. */
export interface WorkerScope {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: { href: string; origin: string };
}

export interface FetchEventLike {
  request: { url: string; method: string; mode: string };
  respondWith(response: Promise<Response>): void;
}

export interface LifecycleEventLike {
  waitUntil(work: Promise<unknown>): void;
}

export interface WorkerEnv {
  scope: WorkerScope;
  caches: CacheStorage;
  /** Files to precache; the first is the app shell. */
  precache: string[];
  /** Changes when the precache list changes, which is what retires old caches. */
  version: string;
  fetch: (request: Request | string) => Promise<Response>;
}

export function attach(env: WorkerEnv): void {
  const cacheName = `${CACHE_PREFIX}${env.version}`;
  const shell = env.precache[0] ?? './';
  const precached = new Set(env.precache.map((path) => new URL(path, env.scope.location.href).pathname));

  env.scope.addEventListener('install', (event: LifecycleEventLike) => {
    event.waitUntil(
      (async () => {
        const cache = await env.caches.open(cacheName);
        // `reload` so a stale HTTP cache cannot seed the precache with the
        // previous deploy's files.
        await cache.addAll(env.precache.map((path) => new Request(path, { cache: 'reload' })));
        await env.scope.skipWaiting();
      })(),
    );
  });

  env.scope.addEventListener('activate', (event: LifecycleEventLike) => {
    event.waitUntil(
      (async () => {
        const names = await env.caches.keys();
        await Promise.all(staleCaches(names, cacheName).map((name) => env.caches.delete(name)));
        await env.scope.clients.claim();
      })(),
    );
  });

  env.scope.addEventListener('fetch', (event: FetchEventLike) => {
    const route = routeFor({
      url: event.request.url,
      origin: env.scope.location.origin,
      method: event.request.method,
      mode: event.request.mode,
      precached,
    });

    // 'network' means untouched: no respondWith, no cache lookup, no cache
    // write. Every api.github.com request lands here.
    if (route === 'network') return;

    if (route === 'shell') {
      event.respondWith(
        (async () => (await env.caches.match(shell)) ?? (await env.fetch(event.request.url)))(),
      );
      return;
    }

    event.respondWith(
      (async () => {
        const cached = await env.caches.match(event.request.url);
        if (cached) return cached;

        const response = await env.fetch(event.request.url);
        // Only successful same-origin app assets are ever stored. routeFor()
        // has already excluded everything else; this is the second lock on
        // the same door.
        if (response.ok && response.type !== 'opaque') {
          const cache = await env.caches.open(cacheName);
          await cache.put(event.request.url, response.clone());
        }
        return response;
      })(),
    );
  });
}
