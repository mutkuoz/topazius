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

A static Preact SPA. No backend, no router, no state library — `app.tsx` owns the state and passes
it down.

The layering rule is strict and worth preserving: **`lib/` contains no UI, and `ui/` contains no
GitHub or crypto logic.** Everything with a rule in it lives in `lib/` and is unit-tested without a
browser; components render and delegate.

```
src/
  main.tsx          mount; refuses to run inside a frame
  app.tsx           top-level state: loading | setup | locked | unlocked

  lib/
    types.ts        shared record types, no logic
    crypto.ts       deriveKey, encrypt, decrypt, randomBytes
    db.ts           IndexedDB: five stores, typed accessors
    session.ts      the ONLY place the key and token live in memory
    paths.ts        path normalisation and validation
    frontmatter.ts  lossless parse / patch / serialize
    github.ts       typed REST transport, nothing else
    sync.ts         tree diff, blob hydration, encrypted cache
    concurrency.ts  mapWithConcurrency
    tree.ts         flat paths to a folder tree (pure)
    setup.ts        token validation policy

  ui/
    Setup.tsx  Lock.tsx  Shell.tsx  Tree.tsx  NoteView.tsx
```

### Things that look odd but are load-bearing

Each of these was a bug once. Please do not tidy them away without reading why.

**`session.ts` holds the key in a closure variable.** Not in state, not in a module export, not
passed as a prop. `getKey()` and `getToken()` throw when locked. Components receive a bound
`readNote` closure rather than the key itself.

**`session.ts` has an epoch counter.** `unlock()` awaits ~600ms of PBKDF2 before assigning anything.
Without the epoch check, a `logout()` during that window is overwritten by the in-flight unlock, and
the token comes back to life on a vault that no longer exists.

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
will keep unsaved edits alive once editing exists.

**`vite.config.ts` narrows `test.fakeTimers`.** `fake-indexeddb` schedules via `setImmediate`;
faking it freezes every IndexedDB operation and hangs unrelated suites. If you need `setInterval` or
`queueMicrotask` faked, widen it per-file rather than globally.

**The CSP is injected at build time, not written in `index.html`.** `script-src 'self'` blocks
Vite's dev bootstrap and HMR socket. The plugin throws if its anchor stops matching, so the policy
cannot silently vanish from a green build.

## Testing

Vitest in happy-dom, with `fake-indexeddb` and `msw`. 154 tests.

- **Real crypto.** Tests run genuine WebCrypto at the real 600,000 iterations. They are a few
  seconds slower for it, and that is the point — reducing the count to speed them up would test a
  different system.
- **Real storage.** `fake-indexeddb`, through the same accessors production uses.
- **Real HTTP shapes.** `msw` with `onUnhandledRequest: 'error'`, so a stray request to any host
  fails the suite. This is part of how "only `api.github.com`" is enforced.
- **No stubbed session.** The app-level tests enrol through the real form with a real passphrase.

If a test fails, fix the code. Several assertions here encode product or security requirements — the
byte-identical frontmatter round-trips, the token-not-in-the-error check, the dirty-note guards —
and weakening one to reach green would silently remove the guarantee it exists to hold.

## Deployment

Two workflows:

- **`ci.yml`** — typecheck, tests, `npm audit`, build, on push and PR.
- **`deploy.yml`** — build and publish to Pages on push to `main` or manual dispatch.

`PAGES_BASE` is set from the repository name at build time, because Pages serves a project site from
`/<repo-name>/`. `scripts/base-path.ts` turns that into Vite's `base`. This is the classic
fork-and-deploy failure and it has a unit test.

## What is not built yet

This is the foundation milestone: the read path. Editing, images, per-note encryption, search, tags,
backlinks, and PWA support are later milestones. The specification for all of it is in
[`superpowers/specs/`](superpowers/specs/), and the plan this milestone was built from is in
[`superpowers/plans/`](superpowers/plans/).

The specs describe the finished system, not what exists today — check the code before assuming a
feature is there.
