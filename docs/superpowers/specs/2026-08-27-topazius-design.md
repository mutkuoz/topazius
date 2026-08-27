# Topazius — Design Spec

**Date:** 2026-08-27
**Status:** Approved for planning

A personal markdown notetaking app that stores every note as a plain `.md` file
in a private GitHub repository the user owns. No backend, no third-party
service, no database. The app is a static page served from GitHub Pages that
talks directly to the GitHub REST API from the browser.

---

## 1. Goals

- **Own your data.** Notes are plain markdown files in a git repo. The vault is
  usable in Obsidian, vim, or `git clone` with no migration and no lock-in.
- **Fork and go.** A user forks the app repo, enables Pages, points it at a
  private notes repo, and is writing notes in under five minutes.
- **No trusted third party.** The only network destination is
  `api.github.com`. No analytics, no CDN, no telemetry, no proxy.
- **Never lose an edit.** Local-first writes, offline queue, and SHA-based
  conflict detection so a second device cannot silently clobber the first.
- **Good UX.** Instant typing, instant search, works on a phone, installable.

## 2. Non-Goals

Explicitly out of scope. Each is cut for a reason, not an oversight.

| Not doing | Why |
|---|---|
| Multi-user, sharing, collaboration | Single-user personal vault. Sharing is `git push`. |
| Real-time sync / CRDTs | Debounced commits plus conflict resolution is sufficient for one person on a few devices. |
| Encrypting notes *in the repo* | Would break Obsidian/vim/`git diff` interop, which is the point of the product. Privacy comes from the repo being private. See §9.6. |
| Note version history UI | Git already has it. Link out to the file's GitHub history page. |
| Non-image attachments (PDF, audio) | Adds upload/preview surface for little gain in v1. |
| Export to PDF/HTML/docx | Out of scope; the files are already portable. |
| Server-side search index | Client-side index is fast enough at personal-vault scale. |

---

## 3. Architecture

### 3.1 Two repositories

```
  github.com/<user>/topazius            github.com/<user>/my-notes
  PUBLIC — app code only                PRIVATE — the vault
  ┌────────────────────────────┐        ┌────────────────────────────┐
  │ src/                       │        │ inbox/idea.md              │
  │ .github/workflows/         │        │ work/standup.md            │
  │   ci.yml                   │        │ recipes/pizza.md           │
  │   deploy.yml ──┐           │        │ assets/2026/08/pic-a1b2.png│
  └────────────────┼───────────┘        │ .topazius.json             │
                   │                    └────────────────────────────┘
                   ▼                                   ▲
        GitHub Pages (static)                          │
        https://<user>.github.io/topazius               │
                   │                                   │
                   └── browser ── fetch + PAT ──────────┘
                                  api.github.com
```

The public fork contains **zero secrets** — it is static JavaScript. The PAT
lives only in the user's browser. Notes never transit anything but the GitHub
API.

**Why two repos:** GitHub Pages cannot serve from a private repository on a
free account. Splitting the public app from the private vault keeps the whole
system free while keeping notes private.

### 3.2 Runtime data flow

```
  ┌──────────┐  keystroke   ┌──────────────┐  400ms debounce  ┌───────────┐
  │ CodeMirror│ ───────────▶│  note state  │ ────────────────▶│ IndexedDB │
  │    6      │             │  (signals)   │                  │(encrypted)│
  └──────────┘              └──────┬───────┘                  └───────────┘
                                   │ 10s idle or ⌘S
                                   ▼
                            ┌─────────────┐   PUT /contents   ┌───────────┐
                            │ write queue │ ─────────────────▶│  GitHub   │
                            └─────┬───────┘   (with base sha) └───────────┘
                                  │ 409                             │
                                  ▼                                 │
                          ┌────────────────┐ ◀──── GET remote ──────┘
                          │ conflict dialog│
                          └────────────────┘
```

Typing never blocks on the network. A commit happens at most once per 10s of
idle per note, so history stays readable.

### 3.3 Module boundaries

Each module has one job, a typed interface, and is unit-testable in isolation.
`lib/` contains no UI; `ui/` contains no GitHub or crypto logic.

```
src/
  main.tsx                 mount, register service worker
  app.tsx                  top-level route: setup | locked | vault

  lib/
    crypto.ts              deriveKey, encrypt, decrypt, wipeKey
    session.ts             unlock/lock state, idle timer, key lifetime
    db.ts                  IndexedDB open/migrate; typed store accessors
    github.ts              typed REST client — transport only, no app logic
    sync.ts                tree diff, blob hydration, save orchestration
    queue.ts               durable write queue, backoff, offline handling
    conflict.ts            409 detection and resolution outcomes
    frontmatter.ts         lossless parse/patch/serialize
    paths.ts               normalize, validate, slugify, rename planning
    markdown.ts            markdown-it + DOMPurify pipeline
    images.ts              downscale, hash, upload, blob-URL resolver
    search.ts              MiniSearch index build/query
    links.ts               [[wikilink]] parse, backlink graph
    tags.ts                frontmatter + inline tag extraction

  editor/
    codemirror.ts          CM6 instance, keymap, markdown language
    live-preview.ts        decoration extension (styled markers)
    paste-image.ts         paste/drop → images.ts

  ui/
    Setup.tsx  Lock.tsx  Shell.tsx  Tree.tsx  Editor.tsx  Preview.tsx
    TagBar.tsx  Palette.tsx  ConflictDialog.tsx  Backlinks.tsx  StatusBar.tsx
```

**Stack:** Preact + `@preact/signals`, Vite, TypeScript (strict), CodeMirror 6,
markdown-it, DOMPurify, MiniSearch. All bundled — no runtime CDN fetches.

---

## 4. Vault layout and note format

### 4.1 Layout

Notes live at the **repo root**, so the private repo *is* the vault and can be
opened directly in Obsidian.

```
<repo root>/
  <any folders you like>/**/*.md     notes
  assets/YYYY/MM/<slug>-<hash>.<ext> images
  .topazius.json                     app preferences (non-secret)
```

`assets/` is reserved and hidden from the note tree. `.topazius.json` holds
non-secret preferences (default folder, theme, editor width, idle-lock minutes)
so they follow the vault across devices.

### 4.2 Note format

```markdown
---
title: Standup notes
tags: [work, weekly]
created: 2026-08-27T09:14:00Z
updated: 2026-08-27T11:02:00Z
---

# Monday

- shipped the thing
- see [[work/roadmap]] and #planning
```

**Title resolution:** `title` frontmatter → first `# H1` → filename stem.

**Frontmatter handling is lossless.** The parser recognizes `title`, `tags`,
`created`, `updated` and preserves every other line — including comments,
ordering, and unknown keys — verbatim. Writes patch only the specific lines
whose values changed; untouched notes round-trip byte-identical. A note with no
frontmatter stays that way unless the user adds a tag or title.

**Tags** come from two places, unioned and de-duplicated:
- Frontmatter `tags:` — inline `[a, b]` or block list form.
- Inline `#tag` in the body: `#` immediately followed by a letter, not at the
  start of a line (that is a heading), and not inside fenced or inline code.

**Wikilinks:** `[[path/to/note]]`, `[[note]]` (resolved by unique basename), and
`[[note|alias]]`. Unresolved links render in a muted "missing" style and offer
one-click creation. The backlink graph is rebuilt with the search index.

### 4.3 Path rules

Enforced by `paths.ts` on create, rename, and move:

- Normalized to Unicode NFC; forward slashes only.
- Rejected: any `..` segment, absolute paths, leading `.` in a segment, empty
  segments, control characters, and Windows-reserved stems (`CON`, `PRN`, …).
- Slugify: trim, collapse whitespace to `-`, strip `/\:*?"<>|`.
- Max 200 bytes per segment, max 400 bytes total.
- Notes must end in `.md`. Creating a note at an existing path is refused.

**Rename/move** is a delete + create pair (two commits) because the Contents API
is single-file. `paths.ts` produces the plan, `queue.ts` executes create-then-
delete so a crash mid-operation duplicates rather than loses a note. Inbound
`[[wikilinks]]` that pointed at the old path are rewritten in the same batch.

---

## 5. Authentication and key management

### 5.1 Credential

A **fine-grained personal access token**, scoped to the single notes repo with
`Contents: Read and write` and nothing else. Setup validates the token before
accepting it:

1. `GET /repos/{owner}/{repo}` — 404 means wrong repo or unscoped token.
2. Inspect the `permissions` field for `push`. The same response supplies
   `default_branch`, which is stored as `config.branch`; the user is never asked
   for it, and it can be changed later in settings.
3. If the response carries an `X-OAuth-Scopes` header, the token is a **classic
   PAT** with broad account access. Accept it, but warn prominently and link
   instructions for creating a fine-grained one.

Onboarding shows the exact settings URL and the exact permission toggles needed.

**Why not OAuth:** GitHub's OAuth and device-flow endpoints on `github.com` do
not send CORS headers, so a browser cannot complete a login without a
server-side proxy. Adding a proxy would reintroduce the trusted third party this
design exists to avoid.

### 5.2 Encryption at rest

```
passphrase ──PBKDF2-SHA256(600_000 iters, 16B random salt)──▶ 256-bit AES-GCM key
                                                                │
PAT ────────────────────AES-GCM(fresh 12B IV)───────────────────┴──▶ IndexedDB
```

Stored record: `{ v: 1, salt, iv, ct }`. No separate passphrase verifier is
needed — AES-GCM's authentication tag fails closed on a wrong passphrase.

The derived key exists only in a module-scoped variable inside `session.ts`. It
is never written to storage, never passed to UI components, and is dropped on
lock. Passphrase minimum 10 characters with a strength meter.

**There is no passphrase recovery.** Forgetting it costs only the stored token —
the notes are safe in GitHub. Recovery is: re-enter a PAT, choose a new
passphrase. This is stated plainly during setup.

### 5.3 Session lifecycle

| Event | Action |
|---|---|
| Idle for N minutes (default 15, configurable 1/5/15/60/never) | Lock: wipe key, clear decrypted state, close editor |
| Tab hidden > 5 minutes | Lock |
| Explicit lock (⌘L) | Lock |
| Logout | `indexedDB.deleteDatabase('topazius')`, revoke object URLs, reload |
| `401` from GitHub | Lock + "token expired or revoked, re-enter PAT" |

---

## 6. Local storage

IndexedDB database `topazius`, version 1.

| Store | Key | Value |
|---|---|---|
| `config` | `'app'` | `{ owner, repo, branch, prefs }` — not secret, not encrypted |
| `secret` | `'pat'` | `{ v, salt, iv, ct }` |
| `notes` | `path` | `{ path, sha, size, enc: {iv, ct}, mtime, dirty }` |
| `assets` | `path` | `{ path, sha, mime, enc: {iv, ct} }` |
| `queue` | auto-inc | `{ id, op, path, payload, attempts, lastError }` |

**Note bodies and image bytes are encrypted at rest** with the same session key.
Disk-resident notes are unreadable without the passphrase — the encryption
covers the cache, not just the token. `config` is deliberately plaintext so the
setup screen can show which repo is configured while locked.

The search index and backlink graph are **not persisted**; they are rebuilt in
memory at unlock (milliseconds at personal-vault scale) which avoids a second
encrypted artifact to manage.

---

## 7. Sync engine

### 7.1 Load

1. Unlock → read `config`.
2. `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1` — the entire file list in
   one request. If the response is `truncated: true` (very large vault), fall
   back to a breadth-first per-directory walk.
3. Diff returned blob SHAs against the `notes`/`assets` caches. Fetch only
   changed or missing blobs via `GET /git/blobs/{sha}` with a concurrency cap of
   6, streaming results into the UI as they land.
4. Build search index and backlink graph.

Cached vaults render instantly; only deltas are fetched.

### 7.2 Save

Writes go through `PUT /repos/{o}/{r}/contents/{path}` with `{ message,
content, sha, branch }`. Supplying the base `sha` gives optimistic concurrency
for free.

| Response | Handling |
|---|---|
| `200` / `201` | Update cached SHA, clear `dirty`, mark synced |
| `409` | Conflict flow (§7.3) |
| `401` | Lock session, prompt for a new token |
| `403` + `x-ratelimit-remaining: 0` | Pause queue until reset, show countdown |
| `403` secondary limit | Exponential backoff honoring `Retry-After` |
| `404` | Repo/branch misconfigured → setup screen |
| `422` | Invalid path or oversized content → actionable error |
| Network failure | Stay queued, flip to offline, retry with backoff |

Commit messages: `Update work/standup.md`, `Create recipes/pizza.md`,
`Delete inbox/old.md`, `Add image assets/2026/08/pic-a1b2.png`.

### 7.3 Conflict resolution

On `409`, fetch the remote version and open a modal showing local and remote
side by side with changed regions highlighted. Three outcomes:

- **Keep mine** — re-PUT local content with the remote SHA.
- **Keep theirs** — replace local cache and editor buffer.
- **Merge** — open both in an editable pane; saving PUTs the merged text with
  the remote SHA.

No automatic merging. Silent resolution is how notes get lost.

### 7.4 Offline queue

Operations persist in the `queue` store and survive reloads. The processor is
serialized per path (no two in-flight writes to the same file), retries with
exponential backoff capped at 60s, and surfaces a status-bar chip:
`Synced` / `Saving…` / `Offline — 3 pending` / `Conflict`.

---

## 8. Editor and rendering

### 8.1 CodeMirror 6

`@codemirror/lang-markdown` with GFM extensions. The document text is the single
source of truth — nothing is parsed into an intermediate model and re-serialized,
so files stay byte-identical unless the user typed. (This is the reason CM6 was
chosen over a ProseMirror-based WYSIWYG editor such as Tiptap, whose schema
round-trip silently drops footnotes, raw HTML, reference links, and normalizes
YAML frontmatter.)

**Live-preview decorations** approximate WYSIWYG without leaving plain text:
headings scaled, bold/italic/strikethrough styled, code and quotes tinted, link
and emphasis markers dimmed — and revealed at full opacity on the cursor's line
so editing them is never guesswork. Toggleable.

**Keymap:** `⌘S` sync now · `⌘K` command palette · `⌘P` preview toggle ·
`⌘B`/`⌘I` bold/italic · `⌘⇧F` search · `⌘L` lock · `Esc` close dialog.
Also: list continuation on Enter, Tab/Shift-Tab list indent, smart pairs for
`` ` ``, `*`, `[`, and Markdown table alignment preserved on edit.

### 8.2 Preview

`markdown-it` (GFM, tables, task lists, footnotes) → **DOMPurify** → DOM.

Sanitizer policy: forbid `script`, `iframe`, `object`, `embed`, `form`, `style`;
forbid all `on*` attributes; allow only `http`, `https`, `mailto`, and internal
note links; force `rel="noopener noreferrer"` on `target="_blank"`. Rendering is
never `innerHTML` without passing through this pipeline.

### 8.3 Images

**Upload** (paste or drop): if the long edge exceeds 1600px or the file exceeds
1MB, downscale on a canvas and re-encode at quality 0.85. Compute a content
hash, write to `assets/YYYY/MM/<slug>-<hash8>.<ext>`, insert
`![alt](assets/2026/08/pic-a1b2.png)` at the cursor — **vault-root-relative, no
leading slash**, which is the form Obsidian and GitHub's own markdown renderer
both resolve. Reject above 5MB post-compression with a clear message. Identical
content hashes are deduplicated to the existing asset.

**Display:** the vault is private, so `raw.githubusercontent.com` URLs will not
load in an `<img>` tag — they require an `Authorization` header. The renderer
therefore rewrites relative image sources: render a sized placeholder, fetch the
blob through the API (or the encrypted cache), and swap in an object URL.
Object URLs are cached per path and revoked on note switch and unmount.

Resolution order for a relative `src`, first hit wins: (1) vault-root-relative,
(2) relative to the containing note's directory. Absolute `http(s)` sources are
left untouched and load normally. Unresolvable sources render a broken-image
placeholder naming the missing path rather than failing silently.

---

## 9. Security

### 9.1 Content Security Policy

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:;
connect-src https://api.github.com;
font-src 'self';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
```

`connect-src` is pinned to the GitHub API — exfiltration to any other origin is
blocked by the browser even if a dependency were compromised. `'unsafe-inline'`
is required for styles only; scripts are strictly same-origin and bundled.

### 9.2 Token handling

Never placed in a URL, query string, `localStorage` plaintext, log line, or
error message. `github.ts` redacts `Authorization` from any thrown error. The
token is read from the session key holder at request time and never copied into
component state.

### 9.3 Service worker

Precaches the **app shell only**. It must never cache `api.github.com`
responses — doing so would write plaintext note content to disk outside the
encrypted store. This is enforced by an explicit origin check in the fetch
handler and covered by a test.

### 9.4 XSS surface

Note content is attacker-controllable in the sense that a user may paste
arbitrary markdown. Every render path goes through DOMPurify (§8.2). Wikilink
and tag rendering builds DOM nodes programmatically rather than by string
concatenation.

### 9.5 Dependency posture

Small, well-known dependency set; all bundled at build time. `npm audit` runs in
CI. No postinstall scripts permitted (`npm ci --ignore-scripts` in CI).

### 9.6 Stated trade-off

**Notes are stored unencrypted in the private repository.** This is deliberate:
encrypting them would break Obsidian, `git diff`, and grep, destroying the
portability that motivates the design. Confidentiality rests on GitHub's private
repo access control. The *local* cache is encrypted, so a stolen laptop does not
expose the vault. This trade-off is documented in the README so no user is
surprised by it.

---

## 10. User interface

### 10.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│ Topazius        ⌘K search…             ● Synced   🔒 ⚙  │
├──────────────┬──────────────────────────┬───────────────┤
│ ▸ inbox      │  # Monday                │  Preview      │
│ ▾ work       │                          │               │
│   standup.md │  - shipped the thing     │  Monday       │
│   roadmap.md │  - see [[work/roadmap]]  │  • shipped …  │
│ ▸ recipes    │                          │               │
├──────────────┤                          ├───────────────┤
│ #work #idea  │                          │ Backlinks (2) │
└──────────────┴──────────────────────────┴───────────────┘
```

Left: folder tree (collapsible, drag to move, context menu for
new/rename/delete) with a tag filter bar beneath it. Center: editor. Right:
preview and backlinks, collapsible.

### 10.2 Command palette (⌘K)

Single entry point: fuzzy quick-open by path, full-text search across note
bodies, and actions (new note, new folder, toggle preview, lock, settings).
Results are grouped and keyboard-navigable.

### 10.3 Search

MiniSearch over `{ path, title, tags, body }` with prefix and fuzzy matching,
title and tag fields boosted. Results show a highlighted snippet. Index is built
at unlock and updated incrementally on each local save.

### 10.4 Mobile and PWA

Below 768px the three panes collapse to one with a bottom tab bar
(Files / Edit / Preview). Tap targets ≥44px. The editor keeps the toolbar above
the soft keyboard using `visualViewport`. A web app manifest plus the app-shell
service worker make it installable to the home screen; cached notes are readable
offline and edits queue until reconnect.

### 10.5 Accessibility

Tree implements `role="tree"`/`treeitem` with full arrow-key navigation. Dialogs
trap focus and restore it on close. All controls reachable by keyboard and
labelled. Contrast meets WCAG AA in both light and dark themes.
`prefers-reduced-motion` and `prefers-color-scheme` respected.

### 10.6 Onboarding

1. **Welcome** — what this is, what it will ask for, the one-time cost.
2. **Create the vault** — link to GitHub's "new repository" page with the
   private option pre-explained; or pick an existing repo.
3. **Token** — exact settings URL, exact toggles, then validation (§5.1).
4. **Passphrase** — set it, with the no-recovery warning stated plainly.
5. **Seed** — offer to create a `welcome.md` explaining the vault layout.

---

## 11. GitHub Actions

### `.github/workflows/ci.yml`
On push and pull request: Node 24, `npm ci --ignore-scripts`, `tsc --noEmit`,
`vitest run`, `npm audit --omit=dev`, `npm run build`.

### `.github/workflows/deploy.yml`
On push to `main` and `workflow_dispatch`: build, `actions/upload-pages-artifact`,
`actions/deploy-pages`. Permissions `pages: write`, `id-token: write`,
`contents: read`; concurrency group `pages` to cancel superseded runs.

**Base path:** Pages serves the fork at `/<repo-name>/`, so Vite's `base` is set
from `/${{ github.event.repository.name }}/` at build time and defaults to `/`
for local development. Getting this wrong is the classic fork-and-deploy failure
and is covered by a build assertion.

Forked repos have Actions disabled by default; the README states that Actions
and Pages (source: GitHub Actions) must both be enabled once after forking.

---

## 12. Error handling

Every failure is surfaced with what happened, what it means, and the next
action — never a raw status code. Errors are non-blocking toasts except those
that require a decision (conflict, expired token), which are modal. Nothing is
silently swallowed: a failed write stays `dirty` and queued, and the status chip
reflects it until resolved.

## 13. Testing

**Vitest** with `fake-indexeddb` and **msw** mocking `api.github.com`. Logic
lives in `lib/` precisely so it is testable without a browser.

| Module | Coverage |
|---|---|
| `crypto` | encrypt/decrypt round-trip; wrong passphrase rejects; salt/IV uniqueness |
| `frontmatter` | parse/serialize round-trips byte-identically; comments and unknown keys preserved; both tag list forms; no-frontmatter notes untouched |
| `paths` | traversal rejection, reserved names, slugify, NFC, length caps, rename planning |
| `sync` | tree diff fetches only changed SHAs; truncated-tree fallback |
| `queue` | ordering per path, backoff, persistence across reload, offline flush |
| `conflict` | 409 detection; all three resolution outcomes write the correct SHA |
| `markdown` | XSS corpus is neutralized; link protocol allowlist; `rel` enforcement |
| `images` | downscale thresholds, hash dedup, size rejection |
| `search`/`links`/`tags` | indexing, incremental update, wikilink resolution, inline-tag edge cases (code fences, headings) |
| service worker | API responses are never cached |

Development follows TDD: failing test first, then implementation.

## 14. Performance targets

| Metric | Target |
|---|---|
| Unlock → first note rendered (warm cache) | < 1s |
| Cold load, 200-note vault | < 8s, with notes streaming in |
| Keystroke → paint | < 16ms |
| Search query → results, 500 notes | < 50ms |
| Initial JS bundle | < 250KB gzipped |

## 15. Implementation phases

Sequenced so each phase is independently verifiable.

1. **Skeleton** — Vite/Preact/TS, CI, Pages deploy, base-path handling.
2. **Crypto and session** — key derivation, encrypted store, lock/unlock, idle.
3. **GitHub client and setup flow** — token validation, config, onboarding.
4. **Read path** — tree fetch, blob hydration, encrypted cache, folder tree.
5. **Editor** — CM6, live-preview decorations, preview pane, sanitizer.
6. **Write path** — local-first saves, queue, commits, status chip.
7. **Conflicts and offline** — 409 flow, resolution UI, queue persistence.
8. **Notes lifecycle** — create, rename, move, delete, wikilink rewriting.
9. **Images** — paste/drop, downscale, upload, blob-URL resolver.
10. **Search, tags, backlinks** — index, palette, tag filter, backlink panel.
11. **Mobile and PWA** — responsive layout, manifest, service worker.
12. **Polish** — accessibility pass, error copy, README and fork instructions.
