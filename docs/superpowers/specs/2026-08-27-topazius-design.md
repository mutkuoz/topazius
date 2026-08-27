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
- **Encrypt what matters.** Any individual note can be sealed so that not even
  GitHub can read it, without forcing that cost on the whole vault.
- **Never lose an edit.** Local-first writes, offline queue, and SHA-based
  conflict detection so a second device cannot silently clobber the first.
- **Good UX.** Instant typing, instant search, works on a phone, installable.

## 2. Non-Goals

Explicitly out of scope. Each is cut for a reason, not an oversight.

| Not doing | Why |
|---|---|
| Multi-user, sharing, collaboration | Single-user personal vault. Sharing is `git push`. |
| Real-time sync / CRDTs | Debounced commits plus conflict resolution is sufficient for one person on a few devices. |
| Encrypting file and folder names | Would make the repo unbrowsable and unrecoverable by hand, and forces a single index file that every rename must rewrite. Note *contents* can be encrypted per note — see §9. |
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
    vaultkey.ts            VMK generation, wrap/unwrap, recovery key
    noteenc.ts             note seal/open, .md.enc detection, toggle planning
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
  <any folders you like>/**/*.md      notes (plain)
  <any folders you like>/**/*.md.enc  notes (encrypted — §9)
  assets/YYYY/MM/<slug>-<hash>.<ext>  images
  .topazius/
    prefs.json                        preferences (non-secret)
    vault.json                        wrapped vault key (only once encryption is used)
```

`assets/` and `.topazius/` are reserved and hidden from the note tree.
`.topazius/prefs.json` holds non-secret preferences (default folder, theme,
editor width, idle-lock minutes, per-folder encryption defaults) so they follow
the vault across devices. `.topazius/vault.json` holds the wrapped vault key and
is created only if the user encrypts something (§9.2). Neither file ever
contains a secret in usable form.

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
- Notes must end in `.md` (plain) or `.md.enc` (encrypted). Creating a note at
  either form of an existing path is refused: `a.md` and `a.md.enc` are the same
  note in two states and must never coexist.

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

**There is no passphrase recovery** — *while no note is encrypted*. Forgetting
it then costs only the stored token; the notes are safe in GitHub, and recovery
is simply: re-enter a PAT, choose a new passphrase. This is stated plainly
during setup.

The moment the user encrypts their first note this stops being true, because a
forgotten passphrase would then destroy data. §9.3 therefore requires a recovery
key before the first encryption can complete.

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

When encryption is in use, the unwrapped Vault Master Key (§9.2) lives in
`session.ts` memory alongside the session key and is **never** written to
IndexedDB. Its wrapped copies live in the repo, not on the device.

The search index and backlink graph are **not persisted**; they are rebuilt in
memory at unlock (milliseconds at personal-vault scale) which avoids a second
encrypted artifact to manage.

---

## 7. Sync engine

### 7.1 Load

1. Unlock → read `config`.
2. `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1` — the entire file list in
   one request. If the response is `truncated: true` (very large vault), fall
   back to a sequential depth-first per-directory walk, skipping the reserved
   `assets/` and `.topazius/` directories.
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

For encrypted notes, sealing (§9.4) happens before the payload is enqueued, so
plaintext never enters the write queue or an outbound request.

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

An image pasted into an **encrypted** note inherits that state: it is sealed
with the same construction as a note (§9.4, AAD bound to the asset path) and
stored as `<slug>-<hash8>.<ext>.enc`. The resolver below decrypts it
transparently, so nothing in the rendering path changes.

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

## 9. Optional note encryption

Encryption is **off by default and opt-in per note**. A plain note is an
ordinary `.md` file, exactly as §4.2 describes. An encrypted note is the same
content sealed into a `.md.enc` file that only this app — holding the passphrase
or the recovery key — can read.

### 9.1 Threat model

**Protects against:** anyone who gains read access to the repository itself — a
leaked or stolen GitHub session, a repo accidentally flipped to public, a
compromised third-party GitHub App with repo scope, GitHub staff, or a subpoena
served on GitHub.

**Does not protect against:** a compromised browser or device while the vault is
unlocked, a keylogger capturing the passphrase, or metadata analysis (§9.6).

Plain notes are unaffected by this feature; their confidentiality continues to
rest on the repository being private (§10.6).

### 9.2 Key hierarchy

```
passphrase ───PBKDF2-SHA256(600k, salt_p)──▶ KEK_p ──┐
                                                      ├──▶ wrap(VMK) ──▶ .topazius/vault.json
recovery key ─PBKDF2-SHA256(600k, salt_r)──▶ KEK_r ──┘

VMK  (random 256-bit, generated once)  ──AES-256-GCM──▶  note ciphertext
```

The **Vault Master Key** is random, generated once when the user encrypts their
first note, and never leaves the browser unwrapped. It is stored twice in
`.topazius/vault.json`, wrapped under two independent key-encryption keys: one
derived from the passphrase, one from a recovery key.

This indirection buys three properties:

- **Changing the passphrase** rewraps one ~400-byte file. Notes are untouched.
- **A new device** needs only the repo, a PAT, and the passphrase.
- **A forgotten passphrase** is survivable, via the recovery key.

```json
{
  "v": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000 },
  "cipher": "AES-256-GCM",
  "wraps": [
    { "id": "passphrase", "salt": "<b64>", "iv": "<b64>", "ct": "<b64>" },
    { "id": "recovery",   "salt": "<b64>", "iv": "<b64>", "ct": "<b64>" }
  ]
}
```

Unlock tries each wrap in turn; AES-GCM's authentication tag makes a wrong key
fail closed, so no separate verifier is stored. An attacker with repo *write*
access can replace this file but cannot forge a wrap without a valid key —
substitution makes decryption fail loudly rather than silently yielding
attacker-chosen plaintext.

### 9.3 Recovery key — mandatory

The first time a note is encrypted, the app generates a 128-bit recovery key,
renders it as 26 Crockford base32 characters in groups of four, and requires the
user to confirm they have stored it before the encryption completes. It is shown
exactly once. It can be regenerated later from an unlocked vault, which rewraps
the recovery slot and invalidates the previous key.

This is not optional and not skippable. Without it, §5.2's "forgetting your
passphrase costs only the token" silently becomes "forgetting your passphrase
destroys your notes" — not an acceptable failure mode for a notes app.

### 9.4 File format

An encrypted note is UTF-8 text, so GitHub's web UI renders it as a file rather
than an opaque binary blob, and anyone who stumbles across it learns what it is:

```
# topazius-encrypted v1
# https://github.com/<user>/topazius — needs your passphrase or recovery key
TPZ1.<base64url iv>.<base64url ciphertext‖tag>
```

- **Cipher:** AES-256-GCM with a fresh random 96-bit IV per save.
- **AAD:** the literal `TPZ1` concatenated with the note's vault-relative path.

Binding the path as additional authenticated data means ciphertext cannot be
relocated: an attacker with write access cannot move
`journal/private.md.enc` to `inbox/note.md.enc` and have it decrypt. The
consequence is that **renaming an encrypted note re-seals it** under the new
path, handled inside the existing rename plan (§4.3).

The plaintext sealed inside is the note's exact bytes, frontmatter included, so
the lossless round-trip guarantee of §4.2 holds unchanged.

### 9.5 Per-note state, per-folder defaults

A note's encryption state is a property of the note, carried by its extension:
`.md` is plain, `.md.enc` is encrypted. Nothing else determines it. **Moving a
note between folders never changes its state** — there is no implicit,
invisible re-encryption to reason about.

Because toggling every note by hand is tedious, folders may carry a **default**
for newly created notes:

```json
{ "defaults": { "journal/": "encrypted", "work/private/": "encrypted" } }
```

Defaults apply only at creation time and are advisory: they never encrypt or
decrypt an existing note. The most specific matching prefix wins; unmatched
folders default to plain.

**Toggling** a note reuses the §4.3 rename machinery — write the new path, then
delete the old. Wikilink targets resolve on the stem, ignoring `.md`/`.md.enc`,
so toggling never breaks inbound links and no link rewriting is needed.

**Bulk actions** — "encrypt every note in this folder", "decrypt this folder" —
are available from the tree context menu and run as a resumable batch through
the write queue, with progress and an explicit report of any failures. This
delivers whole-vault and per-folder behaviour on demand without making either a
standing rule.

### 9.6 What still leaks

Stated plainly in the README, and in the UI the first time a user encrypts a
note:

| Visible to anyone with repo access | Hidden |
|---|---|
| File and folder names — including any title embedded in a filename | All note content |
| Which notes are encrypted, and how many | Frontmatter, tags, wikilinks, body |
| Approximate size of each note | Everything above, for every encrypted note |
| Commit timestamps, so edit frequency and activity patterns | |

Guidance shown alongside this table: keep sensitive detail out of filenames —
`journal/2026-08-27.md.enc`, not `journal/therapy-session.md.enc`.

### 9.7 Interaction with the rest of the system

| Area | Behaviour |
|---|---|
| **Search** | Unaffected. The vault is decrypted into memory at unlock, so encrypted notes are fully searchable. |
| **Tags, backlinks** | Unaffected, for the same reason. |
| **Conflicts** | SHA comparison happens on ciphertext, so detection is unchanged. Resolution decrypts both sides, merges in plaintext, then re-seals. The dialog never displays ciphertext. |
| **Offline queue** | Sealing happens before enqueue, so queued payloads are ciphertext at rest. |
| **Images** | An image inherits the state of the note it is pasted into (§8.3). |
| **Toggling a note to encrypted** | Assets referenced *only* by that note are offered for sealing in the same batch. Assets also referenced by plain notes are left alone, with a warning naming them. |
| **Git storage** | Ciphertext does not delta-compress, so each save of an encrypted note stores a full blob. At personal-vault sizes with 10s save debouncing this is negligible, and per-note opt-in confines the cost to the notes that need it. |
| **Local cache** | Already encrypted at rest under the session key (§6), independently of this feature. |
| **Obsidian and vim** | Plain notes open normally. Encrypted notes appear as `.md.enc` files these tools cannot read — the accepted cost, incurred only on the notes the user chose. |

### 9.8 Failure handling

- **Wrong passphrase and wrong recovery key** — unlock is refused, nothing is
  written, the vault stays sealed.
- **A single note fails to decrypt** (corrupted blob, hand-edited file) — that
  note renders an error card offering "view raw" and "open history on GitHub",
  and the rest of the vault opens normally. One bad file never blocks the vault.
- **`.topazius/vault.json` missing while `.md.enc` files exist** — the app
  refuses to guess, explains that the key file is gone, and points at that
  file's git history, which is where it can be recovered.
- **A toggle batch is interrupted** — the queue is durable and resumable, and
  create-then-delete ordering means an interrupted toggle leaves both copies,
  never neither.

---

## 10. Security

### 10.1 Content Security Policy

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

**`frame-ancestors` is not enforced by this policy as delivered.** CSP Level 3
specifies that `frame-ancestors` is ignored when the policy is set via a
`<meta http-equiv>` element rather than the `Content-Security-Policy` response
header, and GitHub Pages — this app's deploy target — does not let a static
site set response headers. A response-header CSP is not an option here, so the
frame-busting requirement `frame-ancestors 'none'` states is carried instead by
`main.tsx`, which checks `self !== top` before mounting and refuses to run
inside a frame.

### 10.2 Token handling

Never placed in a URL, query string, `localStorage` plaintext, log line, or
error message. `github.ts` redacts `Authorization` from any thrown error. The
token is read from the session key holder at request time and never copied into
component state.

### 10.3 Service worker

Precaches the **app shell only**. It must never cache `api.github.com`
responses — doing so would write plaintext note content to disk outside the
encrypted store. This is enforced by an explicit origin check in the fetch
handler and covered by a test.

### 10.4 XSS surface

Note content is attacker-controllable in the sense that a user may paste
arbitrary markdown. Every render path goes through DOMPurify (§8.2). Wikilink
and tag rendering builds DOM nodes programmatically rather than by string
concatenation.

### 10.5 Dependency posture

Small, well-known dependency set; all bundled at build time. `npm audit` runs in
CI. No postinstall scripts permitted (`npm ci --ignore-scripts` in CI).

### 10.6 Stated trade-off

**Plain notes are stored unencrypted in the private repository.** That is the
default and it is deliberate: encrypting everything by force would break
Obsidian, `git diff`, and grep, destroying the portability that motivates the
whole design. For plain notes, confidentiality rests on GitHub's private-repo
access control.

Notes that need more can be sealed individually (§9), at the cost of being
readable only through this app. The *local* cache is encrypted either way, so a
stolen laptop never exposes the vault. Both trade-offs are documented in the
README so no user is surprised by either.

---

## 11. User interface

### 11.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│ Topazius        ⌘K search…             ● Synced   🔒 ⚙  │
├──────────────┬──────────────────────────┬───────────────┤
│ ▸ inbox      │  # Monday                │  Preview      │
│ ▾ work       │                          │               │
│   standup.md │  - shipped the thing     │  Monday       │
│   roadmap.md │  - see [[work/roadmap]]  │  • shipped …  │
│ ▸ recipes    │                          │               │
│ ▾ journal    │                          │               │
│   aug27 [enc]│                          │               │
├──────────────┤                          ├───────────────┤
│ #work #idea  │                          │ Backlinks (2) │
└──────────────┴──────────────────────────┴───────────────┘
```

Encrypted notes carry an `[enc]` badge in the tree and a lock in the editor
header, and the palette offers an **Encrypted** filter listing every sealed note
in the vault — so "which notes are protected?" is always one keystroke from an
answer, never a guess.

Left: folder tree (collapsible, drag to move, context menu for
new/rename/delete/encrypt) with a tag filter bar beneath it. Center: editor. Right:
preview and backlinks, collapsible.

### 11.2 Command palette (⌘K)

Single entry point: fuzzy quick-open by path, full-text search across note
bodies, and actions (new note, new folder, toggle preview, lock, settings).
Results are grouped and keyboard-navigable.

### 11.3 Search

MiniSearch over `{ path, title, tags, body }` with prefix and fuzzy matching,
title and tag fields boosted. Results show a highlighted snippet. Index is built
at unlock and updated incrementally on each local save.

### 11.4 Mobile and PWA

Below 768px the three panes collapse to one with a bottom tab bar
(Files / Edit / Preview). Tap targets ≥44px. The editor keeps the toolbar above
the soft keyboard using `visualViewport`. A web app manifest plus the app-shell
service worker make it installable to the home screen; cached notes are readable
offline and edits queue until reconnect.

### 11.5 Accessibility

Tree implements `role="tree"`/`treeitem` with full arrow-key navigation. Dialogs
trap focus and restore it on close. All controls reachable by keyboard and
labelled. Contrast meets WCAG AA in both light and dark themes.
`prefers-reduced-motion` and `prefers-color-scheme` respected.

### 11.6 Onboarding

1. **Welcome** — what this is, what it will ask for, the one-time cost.
2. **Create the vault** — link to GitHub's "new repository" page with the
   private option pre-explained; or pick an existing repo.
3. **Token** — exact settings URL, exact toggles, then validation (§5.1).
4. **Passphrase** — set it, with the no-recovery warning stated plainly.
5. **Seed** — offer to create a `welcome.md` explaining the vault layout.

Encryption is deliberately absent from onboarding. It is introduced in context,
the first time the user clicks the lock on a note, together with the
recovery-key ceremony (§9.3) and the leakage table (§9.6).

---

## 12. GitHub Actions

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

## 13. Error handling

Every failure is surfaced with what happened, what it means, and the next
action — never a raw status code. Errors are non-blocking toasts except those
that require a decision (conflict, expired token), which are modal. Nothing is
silently swallowed: a failed write stays `dirty` and queued, and the status chip
reflects it until resolved.

## 14. Testing

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
| `vaultkey` | VMK wrap/unwrap under both slots; wrong passphrase and wrong recovery key each fail closed; passphrase change rewraps without touching note ciphertext |
| `noteenc` | seal/open round-trips byte-identically; AAD binding rejects ciphertext moved to another path; plain↔encrypted toggle preserves content and inbound wikilinks; one corrupt note does not block vault unlock |
| `markdown` | XSS corpus is neutralized; link protocol allowlist; `rel` enforcement |
| `images` | downscale thresholds, hash dedup, size rejection |
| `search`/`links`/`tags` | indexing, incremental update, wikilink resolution, inline-tag edge cases (code fences, headings) |
| service worker | API responses are never cached |

Development follows TDD: failing test first, then implementation.

## 15. Performance targets

| Metric | Target |
|---|---|
| Unlock → first note rendered (warm cache) | < 1s |
| Cold load, 200-note vault | < 8s, with notes streaming in |
| Keystroke → paint | < 16ms |
| Search query → results, 500 notes | < 50ms |
| Initial JS bundle | < 250KB gzipped |

## 16. Implementation phases

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
10. **Optional encryption** — vault key and recovery key, seal/open, per-note
    toggle, folder defaults, bulk batches, encrypted assets.
11. **Search, tags, backlinks** — index, palette, tag filter, backlink panel.
12. **Mobile and PWA** — responsive layout, manifest, service worker.
13. **Polish** — accessibility pass, error copy, README and fork instructions.
