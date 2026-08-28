import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { resolveBase } from './scripts/base-path.js';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src https://api.github.com",
  "font-src 'self'",
  // The web app manifest and the service worker are same-origin files the
  // installable-app milestone needs; default-src 'none' would otherwise block
  // both, and the failure is silent (no install prompt, no offline).
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'topazius-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html; // dev server: skip, HMR needs inline + ws
        // String.replace() on a literal that isn't found just returns the
        // input unchanged - if index.html's <head> ever gains an attribute,
        // this would silently stop injecting the CSP with a green build.
        // Throw instead so that failure is loud.
        const injected = html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        );
        if (injected === html) {
          throw new Error(
            'topazius-csp: could not find a literal "<head>" tag in index.html; the CSP meta tag was not injected.',
          );
        }
        return injected;
      },
    },
  };
}

/**
 * Builds src/sw/sw.ts into dist/sw.js and injects the list of files to
 * precache, which is only known once the bundle exists.
 *
 * The alternative - a hand-written sw.js in public/ - would mean a precache
 * list maintained by hand against hashed filenames, which is exactly the kind
 * of thing that silently rots into caching last week's bundle forever.
 */
function serviceWorker(base: string): Plugin {
  const entry = fileURLToPath(new URL('./src/sw/sw.ts', import.meta.url));
  let referenceId: string | undefined;

  return {
    name: 'topazius-service-worker',
    apply: 'build',

    buildStart() {
      referenceId = this.emitFile({ type: 'chunk', id: entry, fileName: 'sw.js' });
    },

    generateBundle(_options, bundle) {
      const swFile = referenceId ? this.getFileName(referenceId) : 'sw.js';
      const assets = Object.keys(bundle)
        .filter((file) => file !== swFile && !file.endsWith('.map'))
        .map((file) => `${base}${file}`);
      // index.html first: sw.ts treats the head of the list as the app shell.
      const precache = [
        `${base}index.html`,
        ...assets.filter((file) => !file.endsWith('index.html')),
        // Copied verbatim from public/ rather than emitted, so they are not in
        // `bundle` - but an installed app with no icon and no manifest offline
        // is not installed in any useful sense.
        `${base}manifest.webmanifest`,
        `${base}icon-192.png`,
        `${base}icon-512.png`,
      ];
      const version = createHash('sha256').update(precache.join('|')).digest('hex').slice(0, 12);

      const chunk = bundle[swFile];
      if (!chunk || chunk.type !== 'chunk') {
        throw new Error(`topazius-service-worker: ${swFile} is missing from the bundle.`);
      }
      if (/(^|[;\s])import\s*[({'"]/.test(chunk.code) || /\bexport\s/.test(chunk.code)) {
        // main.tsx registers this as a *classic* worker, for the widest
        // support. Everything it needs is inlined today; if that ever stops
        // being true the worker must become type:'module' at registration,
        // so fail the build rather than ship one that dies on install.
        throw new Error(
          'topazius-service-worker: the emitted worker is no longer self-contained. ' +
            "Inline its imports, or register it with { type: 'module' } in main.tsx.",
        );
      }
      if (!chunk.code.includes('__PRECACHE__') || !chunk.code.includes('__VERSION__')) {
        // A rename or a minifier that folds the placeholders away would leave
        // a worker that precaches nothing, and it would still deploy green.
        throw new Error(
          'topazius-service-worker: the precache placeholders are not in the emitted worker.',
        );
      }

      chunk.code = chunk.code
        .replaceAll('__PRECACHE__', JSON.stringify(precache))
        .replaceAll('__VERSION__', JSON.stringify(version));
    },
  };
}

const base = resolveBase(process.env);

export default defineConfig({
  base,
  plugins: [preact(), csp(), serviceWorker(base)],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    // fake-indexeddb schedules its async work via Node's setImmediate. Vitest's
    // default vi.useFakeTimers() fakes setImmediate too, which would freeze every
    // IndexedDB operation made while fake timers are installed. Scope the fake
    // clock to what session.ts's idle lock actually needs: setTimeout/clearTimeout
    // to run the lock callback, and Date so a lazily-checked deadline (see
    // session.ts) observes time advanced via vi.advanceTimersByTime().
    // shouldClearNativeTimers lets the fake clearTimeout hand off to the real one
    // for timers armed before fake timers were installed (session tests install
    // fake timers only after awaiting real PBKDF2-backed enrolment), instead of
    // just warning and leaking them.
    fakeTimers: {
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
      shouldClearNativeTimers: true,
    },
  },
});
