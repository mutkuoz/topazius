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
| Repo/owner/branch config | IndexedDB, on your device | No — deliberately, see below |
| Your notes | Your private GitHub repository | **No** — deliberately, see below |

**Key derivation:** PBKDF2-SHA256, 600,000 iterations, a 16-byte random salt, producing a 256-bit
AES-GCM key. The key is created non-extractable, so even code running on the page cannot read its
raw bytes back out. It exists only in memory, is never written to storage, is never handed to a UI
component, and is dropped when the vault locks.

**Encryption:** AES-256-GCM with a fresh random 12-byte IV for every operation. Cached notes
additionally bind the note's path as authenticated data, so a cached record cannot be swapped from
one path to another.

**Why the config is plaintext.** The lock screen shows which repository it is about to open, and it
has to do that while still locked. Knowing that a browser profile is configured for
`you/my-notes` is not a meaningful disclosure to anyone who already has your device.

**Why your notes are not encrypted in the repository.** This is the significant trade, and it is
deliberate. Encrypting them would break Obsidian, `git diff`, `grep`, and every other tool that can
open a folder of markdown — which is the property that makes the vault yours rather than ours. Their
confidentiality rests on the repository being private. A later milestone adds *optional* per-note
encryption for the notes that need more, at the cost of those notes being readable only through this
app.

## What an attacker gets

**Someone with your unlocked device.** Everything. There is no defence here — the vault is unlocked
because you unlocked it. This is why the idle lock exists.

**Someone with your locked device.** The encrypted token and the encrypted note cache, and nothing
else useful. Both need your passphrase. They also get the config record, so they learn which
repository you use.

**Someone with read access to your notes repository** — a leaked GitHub session, a repo accidentally
made public, an over-scoped token, a compromised GitHub App:

- They read **all of your notes**, because notes are stored as plain markdown.

That is the whole answer, and it is why the private repo matters more than anything else in this
document.

**Someone who compromises GitHub Pages or the app fork.** They could serve modified JavaScript to
you, which would defeat everything else here. Mitigations: the fork is yours, so an attacker needs
your GitHub account to change it; and the shipped page carries a Content Security Policy that pins
`connect-src` to `https://api.github.com`, so even injected code cannot exfiltrate to another host
without also getting a new page past your browser.

## Network

The only destination is `api.github.com`. There is no analytics, no CDN, no font host, no telemetry,
no error reporting. Every dependency is bundled at build time.

This is enforced, not merely intended. The built page carries:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; connect-src https://api.github.com; font-src 'self';
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

**There is no recovery.** No reset link, no backup key, no support address — there is nobody to ask.
If you forget it, the encrypted token on that device is permanently unreadable, and you start over
with a new token and a new passphrase. Your notes are unaffected: they live in GitHub.

The passphrase is used only to derive a key. It is never stored, never transmitted, and never
written to disk in any form.

## Locking

The vault locks:

- after **15 minutes** of no interaction,
- after the tab has been **hidden for 5 minutes**,
- when you press **Lock**,
- when GitHub rejects the token with a 401.

Locking drops the key and the token from memory. The idle timer is backed by a wall-clock deadline
rather than a bare timer, because a browser that freezes a background tab, or a laptop that sleeps,
will happily not run your timers — and an idle lock that silently fails to fire in exactly those
cases would be worse than none.

## Reporting a problem

This is a personal-scale project with no operator. If you find a security issue, open an issue on
the repository you forked from — or, if it is sensitive, contact that repository's owner privately
rather than filing publicly.
