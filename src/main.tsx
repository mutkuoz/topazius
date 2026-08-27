import { render } from 'preact';
import { App } from './app';
import { openVaultDB } from './lib/db';
import './ui/forms.css';

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
