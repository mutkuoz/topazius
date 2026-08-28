# Topazius

Your notes are plain markdown files in a private GitHub repository you own. Topazius is a small web
app that reads and writes them, running entirely in your browser.

There is no server, no account, and no third party. The app talks directly to `api.github.com` from
your browser using a token that never leaves your device. Nobody operates this but you.

---

## Status

**Writing works.** Create, edit, rename, move and delete notes; paste images; seal individual notes
so not even GitHub can read them; search, tag and link them; edit offline and install the app to
your home screen.

| Works today | Not yet |
|---|---|
| Connect a private repo with a token | A settings screen: the idle-lock interval, theme, editor width |
| Create, edit, rename, move, delete notes | Preferences that follow the vault between devices |
| Paste or drop images | Changing your passphrase without re-entering your token |
| Encrypt individual notes, with a recovery key | Browsing a note's history inside the app |
| Full-text search, tags, wikilinks, backlinks | |
| Offline editing, install to home screen | |
| Lock, idle-lock, unlock | |

Every write is local first: typing never waits on the network, and edits made offline are queued and
sent when you reconnect.

## How it works

Two repositories, because GitHub Pages cannot serve from a private repo on a free account:

```
  github.com/<you>/topazius            github.com/<you>/my-notes
  PUBLIC — the app, no secrets         PRIVATE — your notes
  ┌────────────────────────────┐       ┌────────────────────────────┐
  │ src/                       │       │ inbox/idea.md              │
  │ .github/workflows/         │       │ work/standup.md            │
  └─────────────┬──────────────┘       │ journal/aug.md.enc         │
                │                      │ assets/2026/08/pic-a1b2.png│
                ▼                      └────────────────────────────┘
     GitHub Pages (static)                          ▲
     https://<you>.github.io/topazius               │
                │                                   │
                └──── your browser, with your token ┘
                              api.github.com
```

The app repo is public and contains only code — there is nothing secret in it. Your notes live in a
separate private repo. Your token stays in your browser.

Because your notes are ordinary `.md` files in ordinary folders, the same repository opens in
Obsidian, in vim, or with `git clone`. Topazius is a way to work on that vault from a browser, not a
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

Both are required, and the Pages one cannot be automated: the deploy workflow's built-in token is not
permitted to create a Pages site, so the first run fails with *"Get Pages site failed"* until you set
that Source yourself.

Then go to the **Actions** tab, pick the **Deploy** workflow, and press **Run workflow**. When it
finishes, your app is live at `https://<your-username>.github.io/topazius/` — or under your custom
domain, if your account has one configured.

### 3. Create a private repository for your notes

A new, **private** repository — `my-notes` is a fine name. It can be empty; Topazius will create the
first note for you.

Do not put your notes in the fork. The fork is public.

### 4. Create a fine-grained access token

Go to **[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)** and create a token with:

- **Repository access** → *Only select repositories* → choose your notes repo, and nothing else
- **Permissions** → *Repository permissions* → **Contents: Read and write**
- Everything else left alone
- An expiry you are comfortable with — you will need to issue a new one when it lapses

**Avoid a classic token.** A classic token can reach every repository in your account. The app
accepts one but warns you prominently, because a fine-grained token limited to a single repository
is far safer if it is ever exposed.

### 5. Connect

Open your app URL and fill in the repository owner (your username), the repository name, your token,
and a passphrase of at least 10 characters.

The passphrase encrypts your token on this device. **It cannot be recovered.** If you forget it, you
enter a new token and choose a new passphrase — your notes are untouched either way, since they live
in GitHub, not in the app. (Once you encrypt a note, this stops being the whole story: see
[Encrypting a note](#encrypting-a-note).)

## Using it

### Writing

Press **⌘N**, give the note a title, pick a folder if you want one. There is no path to type and no
`.md` to remember: *Weekly standup* in *work* becomes `work/Weekly standup.md`, and the dialog shows
you that before it creates anything. Renaming and moving are the same two fields.

- **Browse** the folder tree on the left; click a note to open it. Every row has a **…** menu —
  rename, move, encrypt, delete — and every folder a **+** for a new note inside it. Notes can also
  be dragged onto a folder to move them.
- **Know where you are.** The bar above the editor names the open note, the folder it lives in
  (click a folder to filter the list to it), whether it is encrypted, and whether it has reached
  GitHub yet.
- **Type.** The editor is markdown, styled as you write: headings scale, emphasis shows, and the
  syntax markers dim until your cursor is on their line. The file on disk is exactly what you typed.
- **Format** from the toolbar or the keyboard: headings, bold, italic, strikethrough, inline code,
  bulleted, numbered and task lists, quotes, links, links to other notes, images, code blocks,
  tables and dividers. Markdown has no paragraph alignment, so neither does the toolbar — alignment
  in markdown is per table column, in the `| --- |` row the table button writes for you.
- **Choose a view**: *Write*, *Split* or *Read* — and collapse the note list entirely when you want
  the window for the words.
- **Saving happens by itself.** Every keystroke lands in local storage immediately; a commit follows
  about ten seconds after you stop typing. `⌘S` commits now.
- **A dot beside a note** means it has changes that have not reached GitHub yet. The chip in the
  header says what the queue is doing: *Synced*, *Saving…*, *Offline — 2 pending*, *Conflict*.

Commits are named for what they did: `Update work/standup.md`, `Create recipes/pizza.md`,
`Delete inbox/old.md`.

### Finding things

- `⌘K` opens the palette: type to fuzzy-open by path, or to search the full text of every note.
  `>` runs a command, `#` filters by tag, and `enc:` lists every encrypted note.
- The **tag bar** under the tree filters the tree by tag. Tags come from frontmatter and from
  `#inline` tags in the body.
- `[[wikilinks]]` resolve by path or by unique filename. A link to a note that does not exist yet is
  shown muted and offers to create it. The **Backlinks** panel lists what points at the open note.

### Images

Paste or drop an image into the editor. It is downscaled if it is over 1600px or 1MB, named by its
content hash, committed to `assets/YYYY/MM/`, and linked at your cursor. Pasting the same image
twice reuses the first upload. Because your repo is private, images cannot be loaded by URL — the app
fetches and decrypts them itself.

### Encrypting a note

Right-click a note → **Encrypt this note**. The first time, the app will:

1. Show you exactly what encryption does and does not hide.
2. Ask for your passphrase, and generate a **vault key** wrapped under it.
3. Show you a **recovery key**, once. Store it. It is the only way back in if you forget your
   passphrase — and once a note is encrypted, a forgotten passphrase would otherwise destroy it.

An encrypted note becomes `<name>.md.enc`, holding ciphertext that only your passphrase or your
recovery key opens. Inside the app it behaves like any other note: it is searchable, linkable and
editable, because it is decrypted in memory when you unlock. Outside the app — in Obsidian, in
`git diff` — it is unreadable. That is the cost, and you pay it only on the notes you choose.

What stays visible to anyone who can read the repository:

| Visible | Hidden |
|---|---|
| File and folder names | Everything inside an encrypted note: title, tags, links, body |
| Which notes are encrypted, and how many | |
| Roughly how large each note is | |
| Commit timestamps, so edit frequency | |

So keep sensitive detail out of filenames: `journal/2026-08-27.md.enc`, not
`journal/therapy-session.md.enc`.

A folder can be encrypted in bulk from its context menu, or set to create new notes encrypted by
default. Moving a note between folders never changes whether it is encrypted.

### Offline, and installing

Cached notes are readable offline and edits are queued until you reconnect — the status chip says
how many are waiting. Where your browser offers it, an **Install** button appears in the header and
adds Topazius to your home screen or dock. The service worker caches the app itself and *never*
caches anything from `api.github.com`.

### Conflicts

If a note changed on GitHub while you were editing it — a second device, a commit from your laptop —
the save is refused rather than forced. Topazius shows both versions side by side with the changed
lines highlighted, and asks: keep mine, keep theirs, or merge by hand. Nothing is resolved silently.

### Locking

- **Lock** with the button in the header or `⌘L`. The vault also locks itself after 15 minutes idle,
  or after the tab has been hidden for 5 minutes.
- **Unlock** with your passphrase. Only the passphrase — the token is already stored, encrypted.
- **I forgot my passphrase** wipes the local data and returns you to setup. It does not touch your
  notes.

### Keyboard

| | |
|---|---|
| `⌘K` / `⌘⇧F` | Palette: quick-open, search, commands |
| `⌘N` | New note |
| `⌘S` | Commit now |
| `⌘P` | Show or hide the preview |
| `⌘B` / `⌘I` | Bold, italic |
| `⌘L` | Lock |
| `Esc` | Close a dialog |

### Your vault is your folders

Any `.md` (or `.md.enc`) file in any folder appears in the tree; nested folders nest. Two directory
names are reserved and hidden: `assets/` and `.topazius/`.

Notes may carry YAML frontmatter, which is read for the title and tags:

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
- Your **plain notes in the repository are not encrypted.** They are ordinary markdown, on purpose —
  that is what keeps them readable by Obsidian, vim, and `git diff`. Their privacy comes from the
  repository being private.
- Your **encrypted notes** are sealed with a key that never leaves your browser unwrapped. GitHub
  stores only ciphertext, and the ciphertext is bound to the note's path, so it cannot be moved
  elsewhere and still open.
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

**The chip says "Offline" and a note has a dot.** Your edits are saved locally and queued. They go
out on the next successful request; **Retry** forces one.

**The chip says "Conflict".** That note changed on GitHub while you were editing it. Open it and
choose which version wins — nothing has been overwritten.

**"This note is encrypted. Unlock the vault key to read it."** This device has not seen the vault key
yet, or it was rewrapped elsewhere. Use **Unlock encrypted notes** in the header and enter your
passphrase or your recovery key.

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
