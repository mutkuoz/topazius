import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// main.tsx runs its mount logic as a module-level side effect, so the test
// resets the module registry and re-imports it fresh rather than calling an
// exported function. The frame-buster guard short-circuits before
// openVaultDB() is ever called, so this needs no IndexedDB setup/teardown.
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main: frame-buster', () => {
  it('refuses to mount when the app is not the top frame', async () => {
    // frame-ancestors is unenforceable via the <meta> CSP this app ships,
    // and GitHub Pages cannot set response headers to carry it as one
    // instead (spec §10.1) - main.tsx carries that requirement itself.
    vi.stubGlobal('top', {} as unknown as Window);

    await import('../src/main');

    expect(document.getElementById('app')?.textContent).toMatch(/refuses to run inside a frame/i);
  });
});
