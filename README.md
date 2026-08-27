# Topazius

Your notes are plain markdown files in a private GitHub repository you own. Topazius is a small web
app that reads them, running entirely in your browser.

There is no server, no account, and no third party. The app talks directly to `api.github.com` from
your browser using a token that never leaves your device. Nobody operates this but you.

---

## Status: read-only

**This milestone can browse and read your notes. It cannot yet create, edit, or save them.**

Worth being blunt about, because everything else here describes a notes app and you would reasonably
expect to write notes with it. Not yet.

| Works today | Not yet |
|---|---|
| Connect a private repo with a token | Creating, editing, or deleting notes |
| Unlock with a passphrase | Images |
| Browse notes as a folder tree | Per-note encryption |
| Read a note | Full-text search, tags, backlinks |
| Lock, idle-lock, unlock | Offline editing, install to home screen |

Editing arrives in the next milestone. The read path, the storage layout, and the security model are
finished and are what later work builds on.

## How it works

Two repositories, because GitHub Pages cannot serve from a private repo on a free account:

```
  github.com/<you>/topazius            github.com/<you>/my-notes
  PUBLIC — the app, no secrets         PRIVATE — your notes
  ┌────────────────────────────┐       ┌────────────────────────────┐
  │ src/                       │       │ inbox/idea.md              │
  │ .github/workflows/         │       │ work/standup.md            │
  └─────────────┬──────────────┘       │ recipes/pizza.md           │
                │                      └────────────────────────────┘
                ▼                                    ▲
     GitHub Pages (static)                           │
     https://<you>.github.io/topazius                │
                │                                    │
                └──── your browser, with your token ─┘
                              api.github.com
```

The app repo is public and contains only code — there is nothing secret in it. Your notes live in a
separate private repo. Your token stays in your browser.

Because your notes are ordinary `.md` files in ordinary folders, the same repository opens in
Obsidian, in vim, or with `git clone`. Topazius is a way to read that vault from a browser, not a
place your notes live.

## Setup

About five minutes, once.

### 1. Fork this repository

Use the **Fork** button. Keep the fork **public** — it holds no secrets, and a public fork is what
lets GitHub Pages serve it for free.

### 2. Enable Actions and Pages on your fork

Both are off by default on a fork.

- **Settings → Actions → General** → *Allow all actions and reusable workflows* → **Save**
- **Settings → Pages** → under *Build and deployment*, set **Source** to **GitHub Actions**

Then go to the **Actions** tab, pick the **Deploy** workflow, and press **Run workflow**. When it
finishes, your app is live at `https://<your-username>.github.io/topazius/`.

### 3. Create a private repository for your notes

A new, **private** repository — `my-notes` is a fine name. It can be empty, though it is easier to
tell things are working if you add a file such as `hello.md` containing `# Hello`.

Do not put your notes in the fork. The fork is public.

### 4. Create a fine-grained access token

Go to **[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)** and create a token with:

- **Repository access** → *Only select repositories* → choose your notes repo, and nothing else
- **Permissions** → *Repository permissions* → **Contents: Read and write**
- Everything else left alone
- An expiry you are comfortable with — you will need to issue a new one when it lapses

A note on that permission: this milestone only ever reads. It asks for write access because the
setup screen checks up front for the permission editing will need, so you are not surprised later by
a token that turns out to be insufficient. If that bothers you, wait for the editing milestone
before setting this up.

**Avoid a classic token.** A classic token can reach every repository in your account. The app
accepts one but warns you prominently, because a fine-grained token limited to a single repository
is far safer if it is ever exposed.

### 5. Connect

Open your app URL and fill in the repository owner (your username), the repository name, your token,
and a passphrase of at least 10 characters.

The passphrase encrypts your token on this device. **It cannot be recovered.** If you forget it,
you enter a new token and choose a new passphrase — your notes are untouched either way, since they
live in GitHub, not in the app.

## Using it

- **Browse** the folder tree on the left; click a note to read it.
- **Lock** with the button in the header. The vault also locks itself after 15 minutes idle, or
  after the tab has been hidden for 5 minutes.
- **Unlock** with your passphrase. Only the passphrase — the token is already stored, encrypted.
- **I forgot my passphrase** wipes the local data and returns you to setup. It does not touch your
  notes.

Your vault is your folders. Any `.md` file in any folder appears in the tree; nested folders nest.
Two directory names are reserved and hidden: `assets/` and `.topazius/`.

Notes may carry YAML frontmatter, which is read for the title:

```markdown
---
title: Standup notes
tags: [work, weekly]
---

# Monday
- shipped the thing
```

Title falls back to the first `# heading`, then to the filename. Frontmatter is preserved exactly as
you wrote it — comments, key order, unknown keys and all.

## Security

The short version:

- Your **token** is encrypted on your device with a key derived from your passphrase
  (AES-256-GCM, PBKDF2-SHA256 at 600,000 iterations). It is never sent anywhere but `api.github.com`,
  never written in the clear, and never appears in a URL, a log, or an error message.
- Your **cached notes** are encrypted on your device too, so a stolen laptop does not expose them.
- Your **notes in the repository are not encrypted.** They are plain markdown, on purpose — that is
  what keeps them readable by Obsidian, vim, and `git diff`. Their privacy comes from the repository
  being private.
- The app contacts **`api.github.com` and nothing else**. No analytics, no CDN, no telemetry. This
  is enforced by a Content Security Policy in the shipped page, not just by convention.

The longer version, including what an attacker with access to your repository could still learn, is
in **[docs/SECURITY.md](docs/SECURITY.md)**. Worth reading before you put anything sensitive in
there.

## Troubleshooting

**"Could not find that repository."** Check the owner and name, and check that the token's
*Repository access* actually includes that repo. A token scoped to the wrong repository produces
exactly this.

**"GitHub rejected that token."** Expired, revoked, or mistyped. Issue a new one.

**"That token can read the repository but cannot write to it."** The token is missing
*Contents: Read and write*.

**The page is blank, or assets 404.** The deploy workflow needs to have run at least once with Pages
set to *GitHub Actions* as its source. Re-run **Deploy** from the Actions tab.

**"That passphrase did not unlock this vault."** The passphrase is wrong, or the local data belongs
to a different vault. Use *I forgot my passphrase* to start over — your notes are safe.

**Nothing loads and the header shows an error.** Your token may have expired; the app locks itself
when GitHub rejects it. Unlock and, if it persists, issue a fresh token.

## Local development

```bash
npm install
npm run dev
```

Tests, architecture and the module layout are in **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

## Design documents

The full specification and the implementation plan this was built from live in
[`docs/superpowers/`](docs/superpowers/). They are more detail than most people need, but they
explain why the design is shaped the way it is.
