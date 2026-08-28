/// <reference lib="webworker" />
import { type WorkerScope, attach } from './worker';

/**
 * The service worker entry. Everything it does lives in worker.ts, which is
 * driven by a test; this file exists to hand that code the real globals and
 * the build-time precache list.
 */

declare const self: ServiceWorkerGlobalScope;

/** Replaced at build time with the emitted asset paths (see vite.config.ts). */
declare const __PRECACHE__: string[];
/** Replaced at build time with a hash of that list. */
declare const __VERSION__: string;

attach({
  // ServiceWorkerGlobalScope is a superset of WorkerScope - the narrow
  // interface worker.ts declares so its behaviour can be driven by a test -
  // but its addEventListener overloads are typed per event name, which no
  // structural subtype can satisfy. The cast is confined to this line.
  scope: self as unknown as WorkerScope,
  caches,
  precache: __PRECACHE__,
  version: __VERSION__,
  fetch: (request) => fetch(request),
});
