# Development

## Getting started

```bash
npm install
npm run dev        # Vite dev server
npm test           # Vitest, single run
npm run test:watch # Vitest, watch mode
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build into dist/
```

Node 24 is what CI uses.

## Architecture

A static Preact SPA. No backend, no router, no state library.

The layering rule is strict and worth preserving: **`lib/` contains no UI, and `ui/` contains no
GitHub or crypto logic.** Everything with a rule in it lives in `lib/` and is unit-tested without a
browser; components render and delegate.

```
src/
  main.tsx          mount; refuses to run inside a frame; registers the service worker
  app.tsx           top-level state: loading | setup | locked | unlocked
  unlocked.tsx      the unlocked half, loaded on demand (see "Code splitting")

  lib/
    types.ts        shared record types, no logic
    crypto.ts       deriveKey, encrypt, decrypt, randomBytes
    db.ts           IndexedDB: six stores, typed accessors
    session.ts      the ONLY place the keys and the token live in memory
    paths.ts        path normalisation and validation
    frontmatter.ts  lossless parse / patch / serialize
    mdscan.ts       code and heading masking, shared by the tag and link scanners
    github.ts       typed REST transport, nothing else
    sync.ts         tree diff, blob hydration, encrypted cache
    notes.ts        note operations against the local cache; rename and relink
    queue.ts        the durable write queue: backoff, conflicts, offline
    conflict.ts     409 description and the three resolutions
    vaultkey.ts     the vault master key, its two wraps, and recovery keys
    noteenc.ts      note sealing, the .md.enc format, folder defaults
    images.ts       downscale, hash, name, resolve, object-URL cache
    markdown.ts     markdown-it → DOMPurify, wikilinks, tags, task lists
    links.ts        wikilink parsing, resolution, backlinks, rewriting
    tags.ts         frontmatter and inline tag extraction
    search.ts       the MiniSearch index and quick-open scoring
    concurrency.ts  mapWithConcurrency
    tree.ts         flat paths to a folder tree (pure)
    setup.ts        token validation policy
    vault.ts        the controller the UI talks to: load, edit, encrypt, sync

  editor/
    setup.ts        the CodeMirror instance: keymap, markdown, paste handling,
                    and the named actions the toolbar runs
    commands.ts     formatting commands, as pure state transforms
    live-preview.ts decorations, as a pure function of document and selection

  sw/
    policy.ts       what may be cached (and what must never be)
    worker.ts       the worker's behaviour, given its globals
    sw.ts           the entry that hands it the real ones

  ui/
    Setup.tsx  Lock.tsx  Shell.tsx  Workspace.tsx  Tree.tsx  Editor.tsx
    Toolbar.tsx  NoteHeader.tsx  NoteDialogs.tsx  Preview.tsx  Palette.tsx
    Panels.tsx  Dialog.tsx  Menu.tsx  Prompt.tsx  ConflictDialog.tsx
    Encryption.tsx  Install.tsx  icons.tsx
```

`vault.ts` is the seam. It owns the queue, the search index and the link graph, and exposes the
operations the UI performs; `Workspace.tsx` is the component that calls them and renders the result.
Neither knows how the other works.

## Things that look odd but are load-bearing

Each of these was a bug once. Please do not tidy them away without reading why.

**`session.ts` holds the keys in closure variables.** Not in state, not in a module export, not
passed as props. `getKey()` and `getToken()` throw when locked; `getVaultKey()` answers null.
Components receive bound closures, never key material.

**`session.ts` has an epoch counter.** `unlock()` awaits ~600ms of PBKDF2 before assigning anything.
Without the epoch check, a `logout()` during that window is overwritten by the in-flight unlock, and
the token comes back to life on a vault that no longer exists.

**`unlock()` opens the vault key too.** That is the only moment the passphrase is in hand, and it is
where the wrapped key file cached in IndexedDB is opened — so the passphrase never has to be held in
memory afterwards.

**`logout()` closes the database it was given.** `deleteDatabase()` blocks forever while a
connection is open, so it must. This makes the session and that handle both dead afterwards, which
is why `app.tsx` reopens and rebuilds rather than reusing them.

**`onChange` replays once on subscribe.** The session starts an async storage probe at construction;
a subscriber attaching later would otherwise miss the resulting notification and sit on a stale
screen forever.

**The idle lock has a wall-clock deadline as well as a timer.** Frozen tabs and sleeping laptops do
not run timers. The timer is the prompt path; the deadline is what makes it trustworthy.

**`frontmatter.ts` keeps the frontmatter block as verbatim text.** Losslessness is structural: the
block is never parsed into a model and re-emitted, so it cannot be reformatted. Replacing this with
a YAML library would produce a spurious `git diff` on every note a user merely opens.

**`sync.ts` never touches a note marked `dirty`.** Not to refetch it, not to evict it. This is what
keeps unsaved edits alive.

**`queue.ts` stores no content.** A queued write is a path and an intent; the bytes are read at send
time, already sealed where sealing applies. That is what keeps plaintext out of the queue store, and
it is also why five saves before the network returns cost one commit.

**A rename queues the create before the delete.** An interrupted rename then leaves two copies rather
than none. `notes.ts` relies on the queue preserving insertion order to guarantee it.

**`noteenc.ts` binds the path as AAD.** Ciphertext cannot be relocated: moving `a.md.enc` to `b.md.enc`
by hand makes it fail to decrypt rather than silently open. The consequence is that renaming a sealed
note re-seals it, which `renameNote` does.

**`Preview.tsx` checks the DOM, not its own render state.** It writes sanitised HTML into a node it
owns, and re-writes it whenever what is in that node is not what it should be — including when Preact
replaces the node. A dependency-guarded effect leaves the pane blank forever in that case.

**Focus is taken in ref callbacks, not effects.** Effects run after paint. `⌘K` is followed
immediately by typing, and a browser run lost the first two characters that way; a dialog closed
before its effects ever ran never restored focus at all.

**`Editor.tsx` reports the path along with the text.** A note switch can land between an edit and the
end of its 400ms debounce, and the pending text belongs to the note it was typed into.

**The toolbar names its commands; it does not import them.** `ui/` asks for `'h1'` or `'bold'` and
`editor/setup.ts` maps that to a CodeMirror command. It is the same rule as everywhere else here:
`ui/` renders and delegates.

**Tree rows put their content in a `<span>`, not straight into the `<button>`.** Chrome lays a
button's children out through an internal box that centres them whatever `justify-content` says -
which silently put every note in the middle of the sidebar with `flex-start` computed and ignored.
Any flex button in this app needs the wrapper.

**`vite.config.ts` narrows `test.fakeTimers`.** `fake-indexeddb` schedules via `setImmediate`;
faking it freezes every IndexedDB operation and hangs unrelated suites. If you need `setInterval` or
`queueMicrotask` faked, widen it per-file rather than globally.

**The CSP is injected at build time, not written in `index.html`.** `script-src 'self'` blocks
Vite's dev bootstrap and HMR socket. The plugin throws if its anchor stops matching, so the policy
cannot silently vanish from a green build.

**The service worker build fails if the worker stops being self-contained.** `main.tsx` registers it
as a classic worker; an emitted `import` would break that at install time, silently, on the deploy.

## Code splitting

`app.tsx` imports `unlocked.tsx` dynamically. CodeMirror, markdown-it, DOMPurify and MiniSearch are
most of the bytes this app ships and none of them are needed to render setup or the lock screen, so
the entry chunk stays around 14KB gzipped — spec §15's budget is 250KB for the initial bundle.

Keep it that way: an import of `lib/vault.ts`, `ui/Workspace.tsx` or anything under `editor/` from
`app.tsx` or `main.tsx` pulls all of it back into the entry chunk. `npm run build` prints the chunk
sizes; the entry chunk is the one named `index-*.js`.

## Testing

Vitest, with `fake-indexeddb` and `msw`. 459 tests.

- **Real crypto.** Tests run genuine WebCrypto at the real 600,000 iterations. They are a few
  seconds slower for it, and that is the point — reducing the count to speed them up would test a
  different system.
- **Real storage.** `fake-indexeddb`, through the same accessors production uses.
- **Real HTTP shapes.** `msw` with `onUnhandledRequest: 'error'`, so a stray request to any host
  fails the suite. This is part of how "only `api.github.com`" is enforced.
- **A real repository, in memory.** `vault.test.ts` runs the whole controller against a fake remote
  that keeps shas, refuses a stale write with a 409, and 404s what it does not have.
- **No stubbed session.** The app-level tests enrol through the real form with a real passphrase.

### Two test files run under jsdom, not happy-dom

`markdown.test.ts` and `workspace-ui.test.tsx` carry a `@vitest-environment jsdom` docblock.
happy-dom defines `nodeName` on `Element` rather than making `Node.prototype`'s getter work for
elements, and DOMPurify reads it through exactly that getter — its defence against a clobbered
property. Under happy-dom the sanitizer therefore sees an empty tag name for every node, strips the
first element, and stops. It would have passed a suite that tested nothing.

`test/setup.ts` also stubs `Range.prototype.getClientRects`, because jsdom has no layout and
CodeMirror measures text from a `requestAnimationFrame` callback that no test awaits.

If a test fails, fix the code. Several assertions here encode product or security requirements — the
byte-identical frontmatter round-trips, the token-not-in-the-error check, the dirty-note guards, the
service worker never touching an API request — and weakening one to reach green would silently
remove the guarantee it exists to hold.

## Deployment

Two workflows:

- **`ci.yml`** — typecheck, tests, `npm audit`, build, on push and PR.
- **`deploy.yml`** — build and publish to Pages on push to `main` or manual dispatch.

`PAGES_BASE` is set from the repository name at build time, because Pages serves a project site from
`/<repo-name>/`. `scripts/base-path.ts` turns that into Vite's `base`. This is the classic
fork-and-deploy failure and it has a unit test.

## What is not built yet

A settings screen (the idle-lock interval, theme, editor width), preferences that follow the vault
between devices via `.topazius/prefs.json`, changing the passphrase without re-entering the token,
and browsing a note's git history inside the app.

The specification in [`superpowers/specs/`](superpowers/specs/) describes the finished system,
including those. It is the design document, not a description of the code — check the code before
assuming a feature is there.
