/**
 * What the service worker is allowed to do with a request.
 *
 * Split out from the worker itself so the rule that matters most - spec
 * §10.3's "never cache api.github.com" - is a pure function with a test, not a
 * branch buried in an event listener that no test can reach.
 */

export type Route =
  /** Serve the cached app shell (a navigation). */
  | 'shell'
  /** Serve from the precache, falling back to the network. */
  | 'cache-first'
  /** Go to the network and cache nothing. */
  | 'network';

export const CACHE_PREFIX = 'topazius-shell-';

export interface RouteInput {
  url: string;
  /** The worker's own origin. */
  origin: string;
  method: string;
  /** The Request's `mode`; 'navigate' means a page load. */
  mode: string;
  /** Pathnames that were precached at install time. */
  precached: ReadonlySet<string>;
}

/**
 * True for anything bound for the GitHub API.
 *
 * Caching one of these would write plaintext note content to disk outside the
 * encrypted store, which is the one thing the service worker must never do.
 */
export function isApiRequest(url: string): boolean {
  try {
    return new URL(url).host === 'api.github.com';
  } catch {
    return false;
  }
}

export function routeFor(input: RouteInput): Route {
  if (input.method !== 'GET') return 'network';

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return 'network';
  }

  // Cross-origin is always straight to the network, uncached. api.github.com
  // is the case this exists for, and the check is by origin rather than by
  // host so no other third party can slip through either.
  if (url.origin !== input.origin) return 'network';
  if (isApiRequest(input.url)) return 'network';

  if (input.mode === 'navigate') return 'shell';
  return input.precached.has(url.pathname) ? 'cache-first' : 'network';
}

/** Old caches to delete on activate: this app's, but not this version's. */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}
