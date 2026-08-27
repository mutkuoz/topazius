# Security model

What Topazius protects, what it does not, and the reasoning behind each choice. Read this before you
put anything sensitive in a vault.

## The shape of the system

Topazius has no backend. It is a static page served from GitHub Pages that runs in your browser and
talks to `api.github.com`. There is no Topazius server, no account, and no operator. Nobody can read
your notes by compromising a service, because there is no service.

That also means there is nobody to recover anything for you.

## What is encrypted, and where

| Thing | Where it lives | Encrypted? |
|---|---|---|
| Your GitHub token | IndexedDB, on your device | **Yes** — AES-256-GCM under a passphrase-derived key |
| Cached note contents | IndexedDB, on your device | **Yes** — same key, with the note's path bound in |
| Cached images | IndexedDB, on your device | **Yes** — same key, same path binding |
| Repo/owner/branch config | IndexedDB, on your device | No — deliberately, see below |
| Plain notes | Your private GitHub repository | **No** — deliberately, see below |
| Notes you encrypted | Your private GitHub repository | **Yes** — AES-256-GCM under the vault key, see [Encrypted notes](#encrypted-notes) |
| The wrapped vault key | `.topazius/vault.json` in your repository | It **is** the wrapped key: useless without your passphrase or recovery key |

**Key derivation:** PBKDF2-SHA256, 600,000 iterations, a 16-byte random salt, producing a 256-bit
AES-GCM key. The session key — the one that protects your token and the local cache — is created
non-extractable, so even code running on the page cannot read its raw bytes back out. It exists only
in memory, is never written to storage, is never handed to a UI component, and is dropped when the
vault locks.

**Encryption:** AES-256-GCM with a fresh random 12-byte IV for every operation. Cached notes
additionally bind the note's path as authenticated data, so a cached record cannot be swapped from
one path to another.

**Why the config is plaintext.** The lock screen shows which repository it is about to open, and it
has to do that while still locked. Knowing that a browser profile is configured for
`you/my-notes` is not a meaningful disclosure to anyone who already has your device.

**Why your notes are not encrypted in the repository by default.** This is the significant trade, and
it is deliberate. Encrypting everything would break Obsidian, `git diff`, `grep`, and every other
tool that can open a folder of markdown — which is the property that makes the vault yours rather
than ours. The confidentiality of a plain note rests on the repository being private.

Notes that need more can be sealed individually — see below — at the cost of being readable only
through this app.

## Encrypted notes

Encryption is off by default and opt-in per note. A sealed note is stored as `<name>.md.enc`
containing a header and one line of ciphertext.

```
passphrase ───PBKDF2-SHA256(600k, salt_p)──▶ KEK_p ──┐
                                                      ├──▶ wrap(vault key) ──▶ .topazius/vault.json
recovery key ─PBKDF2-SHA256(600k, salt_r)──▶ KEK_r ──┘

vault key (random 256-bit, generated once) ──AES-256-GCM──▶ note ciphertext
```

- The **vault key** is random, generated the first time you encrypt something, and never leaves your
  browser unwrapped. It is stored twice in `.topazius/vault.json`, wrapped under a key derived from
  your passphrase and another derived from your recovery key. Two wraps, one key: changing either
  secret rewraps a 400-byte file and touches no note.
- **The recovery key is mandatory.** Before the first note can be encrypted the app generates one,
  shows it once, and makes you confirm you have stored it. Without it, "forgetting your passphrase
  costs only the token" would quietly become "forgetting your passphrase destroys your notes", and
  that is not an acceptable failure mode for a notes app.
- **Ciphertext is bound to its path.** The note's vault-relative path is authenticated data, so
  someone with write access to your repository cannot move `journal/private.md.enc` to
  `inbox/note.md.enc` and have it decrypt. Renaming a sealed note therefore re-seals it, which the
  app does for you.
- **Substitution fails loudly.** An attacker who replaces `.topazius/vault.json` cannot forge a wrap
  without a valid key; unwrapping fails rather than yielding attacker-chosen plaintext.
- **The vault key is extractable in memory**, unlike the session key, and deliberately so: rewrapping
  it under a new recovery key means exporting it and sealing it again, which WebCrypto cannot do to a
  non-extractable key. It still only ever exists in the same closure as your token, is never written
  to storage in any form, and is dropped on lock. The alternative — a vault key that can never be
  rewrapped — would mean no way to replace a recovery key you had lost track of.

### What encryption does not hide

| Visible to anyone with repository access | Hidden |
|---|---|
| File and folder names — including any title in a filename | All note content |
| Which notes are encrypted, and how many | Frontmatter, tags, wikilinks, body |
| Roughly how large each note is | |
| Commit timestamps, so edit frequency and activity patterns | |

Keep sensitive detail out of filenames: `journal/2026-08-27.md.enc`, not
`journal/therapy-session.md.enc`. The app says this too, the first time you encrypt anything.

Encrypted notes are decrypted into memory when you unlock, which is why search, tags and backlinks
work on them normally. That memory is dropped on lock, like everything else.

## What an attacker gets

**Someone with your unlocked device.** Everything. There is no defence here — the vault is unlocked
because you unlocked it. This is why the idle lock exists.

**Someone with your locked device.** The encrypted token and the encrypted note cache, and nothing
else useful. Both need your passphrase. They also get the config record, so they learn which
repository you use.

**Someone with read access to your notes repository** — a leaked GitHub session, a repo accidentally
made public, an over-scoped token, a compromised GitHub App:

- They read **every plain note**, because plain notes are stored as plain markdown.
- They get **nothing but ciphertext** from the notes you encrypted, plus the metadata in the table
  above.
- They get `.topazius/vault.json`, which is useless without your passphrase or recovery key.

For anything you have not encrypted, that is the whole answer, and it is why the private repo
matters more than anything else in this document.

**Someone who compromises GitHub Pages or the app fork.** They could serve modified JavaScript to
you, which would defeat everything else here. Mitigations: the fork is yours, so an attacker needs
your GitHub account to change it; and the shipped page carries a Content Security Policy that pins
`connect-src` to `https://api.github.com`, so even injected code cannot exfiltrate to another host
without also getting a new page past your browser.

## The service worker

The app installs a service worker so it can be installed to a home screen and read offline. It
precaches the app's own files — the HTML, the JavaScript, the CSS, the icons — and **never** caches
a response from `api.github.com`. Caching one would write note content to disk outside the encrypted
store, in the clear, where nothing would ever remove it.

That is not a convention. The worker's routing is a pure function with a test that drives the real
fetch handler and asserts an API request is not even looked at: no cached lookup, no cached write,
no interception at all.

Your notes reach an offline device the other way: through the encrypted IndexedDB cache, which needs
your passphrase.

## Network

The only destination is `api.github.com`. There is no analytics, no CDN, no font host, no telemetry,
no error reporting. Every dependency is bundled at build time.

This is enforced, not merely intended. The built page carries:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; connect-src https://api.github.com; font-src 'self';
manifest-src 'self'; worker-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Two caveats worth stating plainly:

- `frame-ancestors` **does not work in a `<meta>` CSP** — it is only honoured as a response header,
  and GitHub Pages cannot set response headers. The app therefore refuses to mount at all when it
  detects it is inside a frame, which carries the same intent by another route.
- `'unsafe-inline'` appears for **styles only**. Scripts are strictly same-origin and bundled.

## Your token

Use a **fine-grained** token, scoped to your notes repository alone, with *Contents: Read and write*
and nothing else. If it leaks, the blast radius is that one repository.

A **classic** token can reach every repository in your account. Topazius accepts one but warns you
prominently and makes you acknowledge the warning before it stores anything — that acknowledgement
step exists specifically so the warning cannot flash past you.

The token is never placed in a URL, a query string, plaintext storage, a log line, or an error
message. Errors surface only GitHub's own message text; the underlying network exception is
discarded rather than wrapped, because its text can echo the request.

Set an expiry you are comfortable with. When GitHub rejects an expired token the app locks itself
and tells you why.

## Your passphrase

Minimum 10 characters. A strength indicator is shown, but only the length is enforced.

**While nothing is encrypted, there is no recovery and nothing to recover.** No reset link, no
support address — there is nobody to ask. If you forget it, the encrypted token on that device is
permanently unreadable, and you start over with a new token and a new passphrase. Your notes are
unaffected: they live in GitHub.

**Once you encrypt a note, your recovery key is the backstop.** It is generated and shown once,
before the first note is sealed, and it opens the vault key independently of the passphrase. Store
it somewhere other than the device you are typing the passphrase on. A new one can be issued from
the palette at any time, which invalidates the previous one.

The passphrase is used only to derive keys. It is never stored, never transmitted, and never written
to disk in any form — including while the vault key is open: it is used during unlock and dropped
before that call returns.

## Locking

The vault locks:

- after **15 minutes** of no interaction,
- after the tab has been **hidden for 5 minutes**,
- when you press **Lock**,
- when GitHub rejects the token with a 401.

Locking drops the session key, the vault key, and the token from memory. The idle timer is backed by a wall-clock deadline
rather than a bare timer, because a browser that freezes a background tab, or a laptop that sleeps,
will happily not run your timers — and an idle lock that silently fails to fire in exactly those
cases would be worse than none.

## Reporting a problem

This is a personal-scale project with no operator. If you find a security issue, open an issue on
the repository you forked from — or, if it is sensitive, contact that repository's owner privately
rather than filing publicly.
