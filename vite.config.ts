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

export default defineConfig({
  base: resolveBase(process.env),
  plugins: [preact(), csp()],
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
