import { render } from 'preact';
import { App } from './app';
import { openVaultDB } from './lib/db';
import './ui/forms.css';

/**
 * The app-shell service worker (spec §10.3, §11.4), which is what makes the
 * app installable and readable offline. Registered only in a production build:
 * a worker in front of the dev server serves yesterday's bundle and turns
 * every change into a debugging session.
 *
 * Classic rather than module, for the widest support - vite.config.ts fails
 * the build if the emitted worker ever stops being self-contained. Failure
 * here is not fatal: an app with no service worker still works, it just is
 * not installable, so the rejection is logged rather than surfaced.
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch((error: unknown) => console.warn('Service worker registration failed', error));
  });
}

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point is missing from index.html');

/** Rendered in place of the app when it cannot even get as far as opening storage. */
function Fatal({ message }: { message: string }) {
  return (
    <div class="panel">
      <h1>Topazius could not start</h1>
      <p class="alert" role="alert">
        {message}
      </p>
    </div>
  );
}

// frame-ancestors is unenforceable via the <meta> CSP this app ships (CSP
// Level 3), and GitHub Pages cannot set response headers to carry it as one
// instead (spec §10.1). A frame carrying this app would still have a live
// passphrase field and a vault-deleting button, so refuse to run inside one
// rather than relying on a policy the browser will not enforce.
if (self !== top) {
  render(<Fatal message="Topazius refuses to run inside a frame." />, root);
} else {
  registerServiceWorker();

  // If IndexedDB is unavailable - private browsing, storage disabled, a
  // quota refusal - this rejects, and an uncaught rejection here means the
  // app renders nothing at all: a blank page, on the very first thing that
  // runs.
  void openVaultDB()
    .then((db) => render(<App db={db} />, root))
    .catch((error: unknown) => {
      render(
        <Fatal
          message={
            error instanceof Error
              ? error.message
              : 'Could not open local storage. Private browsing, disabled storage, or a full quota can cause this.'
          }
        />,
        root,
      );
    });
}
