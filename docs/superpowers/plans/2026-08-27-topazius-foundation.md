# Topazius Foundation & Read Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of Topazius up to a working read-only vault: a user can set up their repo and token, unlock with a passphrase, and browse and read their notes from a folder tree.

**Architecture:** A static Preact SPA, built by Vite, deployed to GitHub Pages by Actions from a public fork. It talks directly to `api.github.com` from the browser using a fine-grained PAT that is encrypted at rest with a passphrase-derived AES-GCM key. Notes are cached in IndexedDB, also encrypted, so a stolen device does not expose the vault. All GitHub, crypto, and parsing logic lives in `src/lib/` with no UI imports, so every rule in this plan is unit-testable without a browser.

**Tech Stack:** Preact, `@preact/signals`, Vite, TypeScript (strict), `idb`, WebCrypto. Tests: Vitest, happy-dom, fake-indexeddb, msw.

**Spec:** `docs/superpowers/specs/2026-08-27-topazius-design.md`

**Covers:** spec phases 1-4. Phases 5-13 are covered by follow-on plans.

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **Node 24** in CI. Install with `npm ci --ignore-scripts` — no postinstall scripts permitted (§10.5).
- **Key derivation:** PBKDF2-SHA256, **600000 iterations**, 16-byte random salt, deriving a 256-bit AES-GCM key (§5.2).
- **Encryption:** AES-256-GCM, fresh random **12-byte IV** per encryption (§5.2).
- **The derived key exists only in a module-scoped variable inside `session.ts`.** It is never written to storage, never passed to UI components, and is dropped on lock (§5.2).
- **Content Security Policy** (§10.1), applied to production builds only:
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src https://api.github.com; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';`
- **The only network destination is `api.github.com`.** No analytics, no CDN, no telemetry, no proxy (§1).
- **Token handling:** never placed in a URL, query string, `localStorage` plaintext, log line, or error message. `github.ts` redacts `Authorization` from any thrown error. The token is read from the session key holder at request time and never copied into component state (§10.2).
- **Path limits:** max 200 bytes per segment, max 400 bytes total; Unicode NFC; forward slashes only (§4.3).
- **Blob fetch concurrency cap: 6** (§7.1).
- **Idle lock default 15 minutes**, configurable 1/5/15/60/never (§5.3).
- **Reserved paths:** `assets/` and `.topazius/` are hidden from the note tree (§4.1).
- **Notes end in `.md` (plain) or `.md.enc` (encrypted).** `a.md` and `a.md.enc` are the same note in two states and must never coexist (§4.3).
- **Initial JS bundle target: < 250KB gzipped** (§15).

### Dependency note

The spec's dependency list (§3.3) does not mention `idb`. This plan adds it: a small, well-known IndexedDB promise wrapper. Hand-rolling typed IndexedDB request plumbing is a recognised source of subtle bugs, and `idb` satisfies the spec's "small, well-known dependency set" requirement (§10.5).

### File structure produced by this plan

```
scripts/base-path.ts        Pages base-path resolution (pure, testable)
src/
  main.tsx                  mount
  app.tsx                   top-level state: setup | locked | vault
  lib/
    types.ts                shared record and config types — no logic
    crypto.ts               deriveKey, encrypt, decrypt, randomBytes
    db.ts                   IndexedDB open/migrate, typed accessors
    paths.ts                normalize, validate, slugify, note-path predicates
    frontmatter.ts          lossless parse / patch / serialize
    github.ts               typed REST transport — no app logic
    session.ts              unlock/lock, key holder, idle timer
    concurrency.ts          mapWithConcurrency
    sync.ts                 tree diff, blob hydration, encrypted cache write
    tree.ts                 flat paths to TreeNode[] (pure)
  ui/
    Setup.tsx               repo + token + passphrase onboarding
    Lock.tsx                passphrase unlock screen
    Shell.tsx               app frame
    Tree.tsx                folder tree, role="tree"
    NoteView.tsx            read-only note text (editor arrives in plan 2)
test/setup.ts               fake-indexeddb + webcrypto guard
```

---

### Task 1: Project skeleton, CI, and Pages deploy

The base-path bug — a fork deployed to `user.github.io/topazius/` while the bundle requests `/assets/...` — is the classic failure for this kind of project (§12). It gets a unit test before anything else exists.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`
- Create: `scripts/base-path.ts`
- Create: `src/main.tsx`, `test/setup.ts`
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- Test: `test/base-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveBase(env: Record<string, string | undefined>): string`

- [ ] **Step 1: Initialise the project and install dependencies**

Versions are deliberately not pinned here — let npm resolve current ones and commit the lockfile.

```bash
npm init -y
npm install preact @preact/signals idb
npm install -D typescript vite @preact/preset-vite vitest happy-dom fake-indexeddb msw @types/node
```

- [ ] **Step 2: Write the failing test for base-path resolution**

Create `test/base-path.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveBase } from '../scripts/base-path';

describe('resolveBase', () => {
  it('defaults to root for local development', () => {
    expect(resolveBase({})).toBe('/');
  });

  it('wraps a bare repository name in slashes', () => {
    expect(resolveBase({ PAGES_BASE: 'topazius' })).toBe('/topazius/');
  });

  it('normalises a value that already has slashes', () => {
    expect(resolveBase({ PAGES_BASE: '/topazius/' })).toBe('/topazius/');
  });

  it('treats blank and whitespace-only values as root', () => {
    expect(resolveBase({ PAGES_BASE: '' })).toBe('/');
    expect(resolveBase({ PAGES_BASE: '   ' })).toBe('/');
    expect(resolveBase({ PAGES_BASE: '/' })).toBe('/');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/base-path.test.ts`
Expected: FAIL — cannot resolve `../scripts/base-path`.

- [ ] **Step 4: Implement `resolveBase`**

Create `scripts/base-path.ts`:

```ts
/**
 * GitHub Pages serves a project site from /<repo-name>/, so the bundle's asset
 * URLs must be prefixed to match. Local dev and user/organisation sites use '/'.
 */
export function resolveBase(env: Record<string, string | undefined>): string {
  const trimmed = (env.PAGES_BASE ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/base-path.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Write the Vite config, including the production-only CSP**

The CSP cannot be a static tag in `index.html`: `script-src 'self'` blocks Vite's dev-server inline bootstrap and its HMR websocket, so it is injected at build time only. `ctx.bundle` is defined during `vite build` and undefined during `vite dev`, which is the discriminator.

Create `vite.config.ts`:

```ts
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { resolveBase } from './scripts/base-path';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src https://api.github.com",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'topazius-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html; // dev server: skip, HMR needs inline + ws
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        );
      },
    },
  };
}

export default defineConfig({
  base: resolveBase(process.env),
  plugins: [preact(), csp()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
  },
});
```

- [ ] **Step 7: Write the remaining scaffolding files**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src", "test", "scripts", "vite.config.ts"]
}
```

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="referrer" content="no-referrer" />
    <title>Topazius</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `src/main.tsx`:

```tsx
import { render } from 'preact';

function Placeholder() {
  return <p>Topazius</p>;
}

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point is missing from index.html');
render(<Placeholder />, root);
```

Create `test/setup.ts`:

```ts
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// happy-dom does not supply a WebCrypto implementation. Node's is spec-compliant
// and is what crypto.ts exercises, so install it when it is missing.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}
```

Create `.gitignore`:

```
node_modules/
dist/
*.local
.DS_Store
```

Replace the `scripts` block in `package.json` with:

```json
{
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit"
}
```

Also add `"type": "module"` and `"private": true` to `package.json`.

- [ ] **Step 8: Verify typecheck, tests, and build all pass**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, 4 tests pass, `dist/` produced.

Then confirm the CSP was injected into the built output but not the source:

Run: `grep -c 'Content-Security-Policy' dist/index.html index.html`
Expected: `dist/index.html:1` and `index.html:0`.

- [ ] **Step 9: Write the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci --ignore-scripts
      - run: npm run typecheck
      - run: npm test
      - run: npm audit --omit=dev --audit-level=high
      - run: npm run build
```

- [ ] **Step 10: Write the Pages deploy workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci --ignore-scripts
      - run: npm run build
        env:
          PAGES_BASE: ${{ github.event.repository.name }}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: project skeleton with CI, Pages deploy, and production CSP"
```

---

### Task 2: Shared types and crypto primitives

**Files:**
- Create: `src/lib/types.ts`, `src/lib/crypto.ts`
- Test: `test/crypto.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface EncryptedBlob { iv: Uint8Array; ct: Uint8Array }`
  - `interface WrappedSecret extends EncryptedBlob { salt: Uint8Array; v: number }`
  - `interface VaultConfig { owner: string; repo: string; branch: string }`
  - `interface NoteRecord { path: string; sha: string; size: number; enc: EncryptedBlob; mtime: number; dirty: boolean }`
  - `interface AssetRecord { path: string; sha: string; mime: string; enc: EncryptedBlob }`
  - `randomBytes(n: number): Uint8Array`
  - `deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey>`
  - `encrypt(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<EncryptedBlob>`
  - `decrypt(key: CryptoKey, blob: EncryptedBlob, aad?: Uint8Array): Promise<Uint8Array>`
  - `PBKDF2_ITERATIONS`, `SALT_BYTES`, `IV_BYTES`

- [ ] **Step 1: Write the failing tests**

Create `test/crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  IV_BYTES,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  decrypt,
  deriveKey,
  encrypt,
  randomBytes,
} from '../src/lib/crypto';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('crypto', () => {
  it('uses the parameters the spec mandates', () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(SALT_BYTES).toBe(16);
    expect(IV_BYTES).toBe(12);
  });

  it('round-trips plaintext through encrypt and decrypt', async () => {
    const key = await deriveKey('correct horse battery staple', randomBytes(SALT_BYTES));
    const blob = await encrypt(key, enc.encode('hello vault'));
    expect(dec.decode(await decrypt(key, blob))).toBe('hello vault');
  });

  it('fails closed on the wrong passphrase', async () => {
    const salt = randomBytes(SALT_BYTES);
    const blob = await encrypt(await deriveKey('right', salt), enc.encode('secret'));
    const wrong = await deriveKey('wrong', salt);
    await expect(decrypt(wrong, blob)).rejects.toThrow();
  });

  it('fails closed when the salt differs', async () => {
    const blob = await encrypt(await deriveKey('same', randomBytes(SALT_BYTES)), enc.encode('x'));
    const other = await deriveKey('same', randomBytes(SALT_BYTES));
    await expect(decrypt(other, blob)).rejects.toThrow();
  });

  it('emits a fresh IV of the mandated length on every encryption', async () => {
    const key = await deriveKey('pass', randomBytes(SALT_BYTES));
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const { iv } = await encrypt(key, enc.encode('same plaintext'));
      expect(iv).toHaveLength(IV_BYTES);
      seen.add(iv.join(','));
    }
    expect(seen.size).toBe(32);
  });

  it('binds additional authenticated data', async () => {
    const key = await deriveKey('pass', randomBytes(SALT_BYTES));
    const blob = await encrypt(key, enc.encode('body'), enc.encode('work/a.md'));

    expect(dec.decode(await decrypt(key, blob, enc.encode('work/a.md')))).toBe('body');
    await expect(decrypt(key, blob, enc.encode('work/b.md'))).rejects.toThrow();
    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('produces non-extractable keys so they cannot be read back out', async () => {
    const key = await deriveKey('pass', randomBytes(SALT_BYTES));
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/crypto.test.ts`
Expected: FAIL — cannot resolve `../src/lib/crypto`.

- [ ] **Step 3: Write the shared types**

Create `src/lib/types.ts`:

```ts
/** AES-GCM ciphertext with the IV it was sealed under. */
export interface EncryptedBlob {
  iv: Uint8Array;
  ct: Uint8Array;
}

/** An EncryptedBlob plus the KDF salt needed to re-derive its key. */
export interface WrappedSecret extends EncryptedBlob {
  salt: Uint8Array;
  v: number;
}

/** Which repository this vault points at. Not secret. */
export interface VaultConfig {
  owner: string;
  repo: string;
  branch: string;
}

/** A cached note. `enc` holds the note's exact UTF-8 bytes, encrypted. */
export interface NoteRecord {
  path: string;
  sha: string;
  size: number;
  enc: EncryptedBlob;
  mtime: number;
  dirty: boolean;
}

/** A cached image. `enc` holds the raw file bytes, encrypted. */
export interface AssetRecord {
  path: string;
  sha: string;
  mime: string;
  enc: EncryptedBlob;
}
```

- [ ] **Step 4: Implement the crypto primitives**

Create `src/lib/crypto.ts`:

```ts
import type { EncryptedBlob } from './types';

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Derive the vault key from a passphrase. The key is non-extractable, so even
 * a script running in this origin cannot read the raw bytes back out.
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function params(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  const p: AesGcmParams = { name: 'AES-GCM', iv };
  if (aad) p.additionalData = aad;
  return p;
}

export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<EncryptedBlob> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(params(iv, aad), key, plaintext);
  return { iv, ct: new Uint8Array(ct) };
}

/** Throws on a wrong key, a wrong AAD, or tampered ciphertext. Never returns garbage. */
export async function decrypt(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(params(blob.iv, aad), key, blob.ct);
  return new Uint8Array(pt);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/crypto.test.ts`
Expected: PASS — 7 tests.

Note: each `deriveKey` call runs 600000 PBKDF2 iterations and takes roughly 100-300ms, so this file is expected to take a few seconds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/crypto.ts test/crypto.test.ts
git commit -m "feat: AES-GCM crypto primitives with PBKDF2 key derivation"
```

---

### Task 3: IndexedDB layer

**Files:**
- Create: `src/lib/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `types.ts` (`VaultConfig`, `WrappedSecret`, `NoteRecord`, `AssetRecord`)
- Produces:
  - `DB_NAME`, `DB_VERSION`
  - `openVaultDB(): Promise<IDBPDatabase<TopaziusDB>>`
  - `destroyVaultDB(): Promise<void>`
  - `readConfig(db)`, `writeConfig(db, config)`
  - `readSecret(db)`, `writeSecret(db, secret)`
  - `readNote(db, path)`, `writeNote(db, note)`, `allNotes(db)`, `deleteNote(db, path)`
  - `type AppConfig = VaultConfig & { prefs: Record<string, unknown> }`

- [ ] **Step 1: Write the failing tests**

Create `test/db.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  allNotes,
  deleteNote,
  destroyVaultDB,
  openVaultDB,
  readConfig,
  readNote,
  readSecret,
  writeConfig,
  writeNote,
  writeSecret,
} from '../src/lib/db';
import type { NoteRecord } from '../src/lib/types';

function note(path: string, sha: string): NoteRecord {
  return {
    path,
    sha,
    size: 3,
    enc: { iv: new Uint8Array(12), ct: new Uint8Array([1, 2, 3]) },
    mtime: 1_000,
    dirty: false,
  };
}

afterEach(async () => {
  await destroyVaultDB();
});

describe('db', () => {
  it('returns undefined for config and secret on a fresh vault', async () => {
    const db = await openVaultDB();
    expect(await readConfig(db)).toBeUndefined();
    expect(await readSecret(db)).toBeUndefined();
    db.close();
  });

  it('round-trips config', async () => {
    const db = await openVaultDB();
    await writeConfig(db, { owner: 'me', repo: 'my-notes', branch: 'main', prefs: { theme: 'dark' } });
    expect(await readConfig(db)).toEqual({
      owner: 'me',
      repo: 'my-notes',
      branch: 'main',
      prefs: { theme: 'dark' },
    });
    db.close();
  });

  it('round-trips the wrapped secret including its byte arrays', async () => {
    const db = await openVaultDB();
    await writeSecret(db, {
      v: 1,
      salt: new Uint8Array([9, 9]),
      iv: new Uint8Array([8, 8]),
      ct: new Uint8Array([7, 7]),
    });
    const got = await readSecret(db);
    expect(got?.v).toBe(1);
    expect(Array.from(got!.salt)).toEqual([9, 9]);
    expect(Array.from(got!.ct)).toEqual([7, 7]);
    db.close();
  });

  it('stores notes keyed by path and lists them', async () => {
    const db = await openVaultDB();
    await writeNote(db, note('work/a.md', 'sha-a'));
    await writeNote(db, note('recipes/b.md', 'sha-b'));

    expect(await readNote(db, 'work/a.md')).toMatchObject({ sha: 'sha-a' });
    expect((await allNotes(db)).map((n) => n.path).sort()).toEqual(['recipes/b.md', 'work/a.md']);
    db.close();
  });

  it('overwrites a note written twice at the same path', async () => {
    const db = await openVaultDB();
    await writeNote(db, note('work/a.md', 'old'));
    await writeNote(db, note('work/a.md', 'new'));

    expect(await readNote(db, 'work/a.md')).toMatchObject({ sha: 'new' });
    expect(await allNotes(db)).toHaveLength(1);
    db.close();
  });

  it('deletes notes', async () => {
    const db = await openVaultDB();
    await writeNote(db, note('work/a.md', 'sha-a'));
    await deleteNote(db, 'work/a.md');
    expect(await readNote(db, 'work/a.md')).toBeUndefined();
    db.close();
  });

  it('wipes everything on destroy, as logout requires', async () => {
    const first = await openVaultDB();
    await writeNote(first, note('work/a.md', 'sha-a'));
    await writeSecret(first, { v: 1, salt: new Uint8Array(1), iv: new Uint8Array(1), ct: new Uint8Array(1) });
    first.close();

    await destroyVaultDB();

    const second = await openVaultDB();
    expect(await allNotes(second)).toEqual([]);
    expect(await readSecret(second)).toBeUndefined();
    second.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — cannot resolve `../src/lib/db`.

- [ ] **Step 3: Implement the database layer**

Create `src/lib/db.ts`:

```ts
import { type DBSchema, type IDBPDatabase, deleteDB, openDB } from 'idb';
import type { AssetRecord, NoteRecord, VaultConfig, WrappedSecret } from './types';

export const DB_NAME = 'topazius';
export const DB_VERSION = 1;

export type AppConfig = VaultConfig & { prefs: Record<string, unknown> };

interface QueueItem {
  id?: number;
  op: 'put' | 'delete';
  path: string;
  attempts: number;
}

export interface TopaziusDB extends DBSchema {
  /** Deliberately plaintext: the lock screen must be able to name the repo. */
  config: { key: string; value: AppConfig };
  secret: { key: string; value: WrappedSecret };
  notes: { key: string; value: NoteRecord };
  assets: { key: string; value: AssetRecord };
  /** Populated in plan 2; the store is created here so no migration is needed. */
  queue: { key: number; value: QueueItem };
}

export function openVaultDB(): Promise<IDBPDatabase<TopaziusDB>> {
  return openDB<TopaziusDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('config');
      db.createObjectStore('secret');
      db.createObjectStore('notes', { keyPath: 'path' });
      db.createObjectStore('assets', { keyPath: 'path' });
      db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    },
  });
}

/** Logout path: removes the encrypted token and every cached note. */
export async function destroyVaultDB(): Promise<void> {
  await deleteDB(DB_NAME);
}

export function readConfig(db: IDBPDatabase<TopaziusDB>): Promise<AppConfig | undefined> {
  return db.get('config', 'app');
}

export async function writeConfig(db: IDBPDatabase<TopaziusDB>, config: AppConfig): Promise<void> {
  await db.put('config', config, 'app');
}

export function readSecret(db: IDBPDatabase<TopaziusDB>): Promise<WrappedSecret | undefined> {
  return db.get('secret', 'pat');
}

export async function writeSecret(db: IDBPDatabase<TopaziusDB>, secret: WrappedSecret): Promise<void> {
  await db.put('secret', secret, 'pat');
}

export function readNote(db: IDBPDatabase<TopaziusDB>, path: string): Promise<NoteRecord | undefined> {
  return db.get('notes', path);
}

export async function writeNote(db: IDBPDatabase<TopaziusDB>, note: NoteRecord): Promise<void> {
  await db.put('notes', note);
}

export function allNotes(db: IDBPDatabase<TopaziusDB>): Promise<NoteRecord[]> {
  return db.getAll('notes');
}

export async function deleteNote(db: IDBPDatabase<TopaziusDB>, path: string): Promise<void> {
  await db.delete('notes', path);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/db.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts test/db.test.ts
git commit -m "feat: typed IndexedDB layer for config, secret, notes, and assets"
```

---

### Task 4: Path utilities

**Files:**
- Create: `src/lib/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class PathError extends Error`
  - `normalizePath(input: string): string` — throws `PathError` when invalid
  - `isNotePath(path: string): boolean`
  - `isEncryptedPath(path: string): boolean`
  - `noteStem(path: string): string`
  - `isReservedPath(path: string): boolean`
  - `slugify(title: string): string`
  - `MAX_SEGMENT_BYTES`, `MAX_PATH_BYTES`

- [ ] **Step 1: Write the failing tests**

Create `test/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_PATH_BYTES,
  MAX_SEGMENT_BYTES,
  PathError,
  isEncryptedPath,
  isNotePath,
  isReservedPath,
  normalizePath,
  noteStem,
  slugify,
} from '../src/lib/paths';

describe('normalizePath', () => {
  it('accepts and returns a plain vault-relative path', () => {
    expect(normalizePath('work/standup.md')).toBe('work/standup.md');
  });

  it('strips redundant and leading slashes', () => {
    expect(normalizePath('/work//standup.md')).toBe('work/standup.md');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('work\\standup.md')).toBe('work/standup.md');
  });

  it('normalises to Unicode NFC', () => {
    expect(normalizePath('notes/cafe\u0301.md')).toBe('notes/café.md');
  });

  it('rejects directory traversal', () => {
    expect(() => normalizePath('../secrets.md')).toThrow(PathError);
    expect(() => normalizePath('work/../../secrets.md')).toThrow(PathError);
    expect(() => normalizePath('work/../notes.md')).toThrow(PathError);
  });

  it('rejects a segment beginning with a dot', () => {
    expect(() => normalizePath('.topazius/vault.json')).toThrow(PathError);
    expect(() => normalizePath('work/.hidden.md')).toThrow(PathError);
  });

  it('rejects control characters', () => {
    expect(() => normalizePath('work/a\u0000b.md')).toThrow(PathError);
    expect(() => normalizePath('work/a\u0001b.md')).toThrow(PathError);
    expect(() => normalizePath('work/a\nb.md')).toThrow(PathError);
    expect(() => normalizePath('work/a\u007Fb.md')).toThrow(PathError);
  });

  it('rejects Windows-reserved stems in any case', () => {
    expect(() => normalizePath('CON.md')).toThrow(PathError);
    expect(() => normalizePath('work/nul.md')).toThrow(PathError);
    expect(() => normalizePath('work/LPT9.md')).toThrow(PathError);
  });

  it('accepts a name that merely contains a reserved word', () => {
    expect(normalizePath('work/console.md')).toBe('work/console.md');
  });

  it('enforces the byte limits', () => {
    const longSegment = 'a'.repeat(MAX_SEGMENT_BYTES) + '.md';
    expect(() => normalizePath(longSegment)).toThrow(PathError);

    const deep = Array.from({ length: 60 }, () => 'abcdefgh').join('/') + '/x.md';
    expect(deep.length).toBeGreaterThan(MAX_PATH_BYTES);
    expect(() => normalizePath(deep)).toThrow(PathError);
  });

  it('counts limits in bytes, not code units', () => {
    // Each 'ä' is two UTF-8 bytes, so 120 of them exceed a 200-byte segment.
    expect(() => normalizePath('ä'.repeat(120) + '.md')).toThrow(PathError);
  });

  it('rejects an empty path', () => {
    expect(() => normalizePath('')).toThrow(PathError);
    expect(() => normalizePath('///')).toThrow(PathError);
  });
});

describe('note path predicates', () => {
  it('recognises both note forms', () => {
    expect(isNotePath('work/a.md')).toBe(true);
    expect(isNotePath('work/a.md.enc')).toBe(true);
    expect(isNotePath('assets/x.png')).toBe(false);
    expect(isNotePath('README.markdown')).toBe(false);
  });

  it('distinguishes encrypted notes', () => {
    expect(isEncryptedPath('work/a.md.enc')).toBe(true);
    expect(isEncryptedPath('work/a.md')).toBe(false);
  });

  it('collapses both forms to the same stem, so wikilinks survive toggling', () => {
    expect(noteStem('work/a.md')).toBe('work/a');
    expect(noteStem('work/a.md.enc')).toBe('work/a');
  });

  it('treats reserved directories as hidden', () => {
    expect(isReservedPath('assets/2026/08/x.png')).toBe(true);
    expect(isReservedPath('.topazius/vault.json')).toBe(true);
    expect(isReservedPath('work/assets-review.md')).toBe(false);
  });
});

describe('slugify', () => {
  it('collapses whitespace to hyphens', () => {
    expect(slugify('  Standup   Notes ')).toBe('Standup-Notes');
  });

  it('strips characters that are illegal in paths', () => {
    expect(slugify('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi');
  });

  it('collapses and trims hyphen runs', () => {
    expect(slugify('a --- b')).toBe('a-b');
    expect(slugify('---edge---')).toBe('edge');
  });

  it('falls back to a usable name when nothing survives', () => {
    expect(slugify('///')).toBe('untitled');
    expect(slugify('')).toBe('untitled');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/paths.test.ts`
Expected: FAIL — cannot resolve `../src/lib/paths`.

- [ ] **Step 3: Implement the path utilities**

Create `src/lib/paths.ts`:

```ts
export const MAX_SEGMENT_BYTES = 200;
export const MAX_PATH_BYTES = 400;

const RESERVED_DIRS = ['assets/', '.topazius/'];

const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const ILLEGAL_IN_NAME = /[/\\:*?"<>|]/g;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/**
 * Normalise a vault-relative path and reject anything unsafe.
 * Returns the canonical form; throws PathError with a user-facing reason.
 */
export function normalizePath(input: string): string {
  const unified = input.normalize('NFC').replace(/\\/g, '/');
  const segments = unified.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) throw new PathError('Path is empty.');
  if (byteLength(segments.join('/')) > MAX_PATH_BYTES) {
    throw new PathError(`Path is longer than ${MAX_PATH_BYTES} bytes.`);
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new PathError('Path may not contain "." or ".." segments.');
    }
    if (segment.startsWith('.')) {
      throw new PathError(`"${segment}" may not begin with a dot.`);
    }
    if (CONTROL_CHARS.test(segment)) {
      throw new PathError('Path may not contain control characters.');
    }
    if (byteLength(segment) > MAX_SEGMENT_BYTES) {
      throw new PathError(`"${segment}" is longer than ${MAX_SEGMENT_BYTES} bytes.`);
    }
    const stem = segment.split('.')[0] ?? '';
    if (RESERVED_STEMS.has(stem.toLowerCase())) {
      throw new PathError(`"${stem}" is a reserved filename on Windows.`);
    }
  }

  return segments.join('/');
}

export function isNotePath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.md.enc');
}

export function isEncryptedPath(path: string): boolean {
  return path.endsWith('.md.enc');
}

/** Both states of a note share a stem, so wikilinks survive an encryption toggle. */
export function noteStem(path: string): string {
  return path.replace(/\.md(\.enc)?$/, '');
}

export function isReservedPath(path: string): boolean {
  return RESERVED_DIRS.some((dir) => path.startsWith(dir));
}

export function slugify(title: string): string {
  const cleaned = title
    .normalize('NFC')
    .replace(ILLEGAL_IN_NAME, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || 'untitled';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS — 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/paths.ts test/paths.test.ts
git commit -m "feat: path normalisation, validation, and note-path predicates"
```

---

### Task 5: Lossless frontmatter

The spec's hard guarantee (§4.2): a note the user has not edited must round-trip byte-identically, comments and unknown keys included. The implementation earns this by keeping the frontmatter block as verbatim text and patching it line-wise, rather than parsing to a model and re-serialising.

**Files:**
- Create: `src/lib/frontmatter.ts`
- Test: `test/frontmatter.test.ts`

**Interfaces:**
- Consumes: `paths.ts` (`noteStem`)
- Produces:
  - `interface NoteFields { title?: string; tags: string[]; created?: string; updated?: string }`
  - `interface ParsedNote { fmBlock: string; body: string; fields: NoteFields }`
  - `parseNote(source: string): ParsedNote`
  - `serializeNote(note: ParsedNote): string`
  - `patchFrontmatter(source: string, changes: Partial<NoteFields>): string`
  - `resolveTitle(path: string, parsed: ParsedNote): string`

- [ ] **Step 1: Write the failing tests**

Create `test/frontmatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseNote, patchFrontmatter, resolveTitle, serializeNote } from '../src/lib/frontmatter';

const WITH_FM = `---
title: Standup notes
# a comment the user wrote
tags: [work, weekly]
custom_key: something we do not understand
created: 2026-08-27T09:14:00Z
---

# Monday

- shipped the thing
`;

const NO_FM = `# Just a heading

Body text.
`;

describe('parseNote', () => {
  it('splits frontmatter from body', () => {
    const parsed = parseNote(WITH_FM);
    expect(parsed.fields.title).toBe('Standup notes');
    expect(parsed.fields.tags).toEqual(['work', 'weekly']);
    expect(parsed.fields.created).toBe('2026-08-27T09:14:00Z');
    expect(parsed.body.startsWith('\n# Monday')).toBe(true);
  });

  it('reports an empty field set when there is no frontmatter', () => {
    const parsed = parseNote(NO_FM);
    expect(parsed.fmBlock).toBe('');
    expect(parsed.fields.tags).toEqual([]);
    expect(parsed.fields.title).toBeUndefined();
    expect(parsed.body).toBe(NO_FM);
  });

  it('reads the block list form of tags', () => {
    const parsed = parseNote(`---\ntags:\n  - alpha\n  - beta\n---\nbody\n`);
    expect(parsed.fields.tags).toEqual(['alpha', 'beta']);
  });

  it('strips quotes from scalar values', () => {
    const parsed = parseNote(`---\ntitle: "Quoted Title"\n---\nbody\n`);
    expect(parsed.fields.title).toBe('Quoted Title');
  });

  it('does not treat a horizontal rule as frontmatter', () => {
    const source = `Some text\n\n---\n\nMore text\n`;
    const parsed = parseNote(source);
    expect(parsed.fmBlock).toBe('');
    expect(parsed.body).toBe(source);
  });

  it('ignores an unterminated frontmatter fence', () => {
    const source = `---\ntitle: nope\n\nstill going\n`;
    const parsed = parseNote(source);
    expect(parsed.fmBlock).toBe('');
    expect(parsed.body).toBe(source);
  });
});

describe('serializeNote', () => {
  it('round-trips a note with frontmatter byte-identically', () => {
    expect(serializeNote(parseNote(WITH_FM))).toBe(WITH_FM);
  });

  it('round-trips a note without frontmatter byte-identically', () => {
    expect(serializeNote(parseNote(NO_FM))).toBe(NO_FM);
  });

  it('preserves CRLF line endings', () => {
    const crlf = `---\r\ntitle: Windows\r\n---\r\nbody\r\n`;
    expect(serializeNote(parseNote(crlf))).toBe(crlf);
  });
});

describe('patchFrontmatter', () => {
  it('rewrites only the line that changed', () => {
    const out = patchFrontmatter(WITH_FM, { title: 'Renamed' });
    expect(out).toContain('title: Renamed');
    expect(out).toContain('# a comment the user wrote');
    expect(out).toContain('custom_key: something we do not understand');
    expect(out).toContain('tags: [work, weekly]');
    expect(out.split('\n').length).toBe(WITH_FM.split('\n').length);
  });

  it('appends a key that was absent, before the closing fence', () => {
    const out = patchFrontmatter(WITH_FM, { updated: '2026-08-27T11:02:00Z' });
    const lines = out.split('\n');
    const fence = lines.indexOf('---', 1);
    expect(lines[fence - 1]).toBe('updated: 2026-08-27T11:02:00Z');
  });

  it('creates a frontmatter block when the note has none', () => {
    const out = patchFrontmatter(NO_FM, { tags: ['new'] });
    expect(out.startsWith('---\ntags: [new]\n---\n')).toBe(true);
    expect(out.endsWith(NO_FM)).toBe(true);
  });

  it('writes tags back in inline form', () => {
    expect(patchFrontmatter(WITH_FM, { tags: ['a', 'b'] })).toContain('tags: [a, b]');
  });

  it('is a no-op when nothing actually changed', () => {
    expect(patchFrontmatter(WITH_FM, {})).toBe(WITH_FM);
  });

  it('leaves the body untouched', () => {
    const out = patchFrontmatter(WITH_FM, { title: 'Renamed' });
    expect(out).toContain('- shipped the thing');
  });
});

describe('resolveTitle', () => {
  it('prefers frontmatter title', () => {
    expect(resolveTitle('work/standup.md', parseNote(WITH_FM))).toBe('Standup notes');
  });

  it('falls back to the first H1', () => {
    expect(resolveTitle('work/x.md', parseNote(NO_FM))).toBe('Just a heading');
  });

  it('falls back to the filename stem, including for encrypted notes', () => {
    expect(resolveTitle('work/my-note.md', parseNote('no heading here\n'))).toBe('my-note');
    expect(resolveTitle('work/my-note.md.enc', parseNote('no heading\n'))).toBe('my-note');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/frontmatter.test.ts`
Expected: FAIL — cannot resolve `../src/lib/frontmatter`.

- [ ] **Step 3: Implement lossless frontmatter handling**

Create `src/lib/frontmatter.ts`:

```ts
import { noteStem } from './paths';

export interface NoteFields {
  title?: string;
  tags: string[];
  created?: string;
  updated?: string;
}

export interface ParsedNote {
  /** The frontmatter block verbatim, fences and trailing newline included. '' when absent. */
  fmBlock: string;
  /** Everything after the block, verbatim. */
  body: string;
  fields: NoteFields;
}

const SCALAR_KEYS = ['title', 'created', 'updated'] as const;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted?.[2] ?? trimmed;
}

/**
 * Split a note into its frontmatter block and body without reformatting either.
 * Keeping fmBlock as verbatim text is what makes serializeNote byte-exact.
 */
export function parseNote(source: string): ParsedNote {
  const empty: ParsedNote = { fmBlock: '', body: source, fields: { tags: [] } };

  const open = /^---\r?\n/.exec(source);
  if (!open) return empty;

  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(source.slice(open[0].length));
  if (!close) return empty;

  const bodyStart = open[0].length + close.index + close[0].length;
  const fmBlock = source.slice(0, bodyStart);
  const inner = source.slice(open[0].length, open[0].length + close.index);

  return { fmBlock, body: source.slice(bodyStart), fields: readFields(inner) };
}

function readFields(inner: string): NoteFields {
  const fields: NoteFields = { tags: [] };
  const lines = inner.split(/\r?\n/);

  lines.forEach((line, i) => {
    for (const key of SCALAR_KEYS) {
      if (line.startsWith(`${key}:`)) {
        fields[key] = unquote(line.slice(key.length + 1));
      }
    }

    if (!line.startsWith('tags:')) return;

    const rest = line.slice('tags:'.length).trim();
    if (rest.startsWith('[')) {
      fields.tags = rest
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(unquote)
        .filter(Boolean);
      return;
    }
    if (rest === '') {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s*-\s+(.*)$/.exec(lines[j] ?? '');
        if (!item) break;
        fields.tags.push(unquote(item[1] ?? ''));
      }
    }
  });

  return fields;
}

export function serializeNote(note: ParsedNote): string {
  return note.fmBlock + note.body;
}

function renderValue(key: keyof NoteFields, value: string | string[]): string {
  return key === 'tags' ? `tags: [${(value as string[]).join(', ')}]` : `${key}: ${value as string}`;
}

/**
 * Patch frontmatter line-wise. Lines the caller did not name are preserved
 * exactly, including comments, unknown keys, and their original order.
 */
export function patchFrontmatter(source: string, changes: Partial<NoteFields>): string {
  const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as Array<
    [keyof NoteFields, string | string[]]
  >;
  if (entries.length === 0) return source;

  const parsed = parseNote(source);

  if (parsed.fmBlock === '') {
    const block = entries.map(([k, v]) => renderValue(k, v)).join('\n');
    return `---\n${block}\n---\n${source}`;
  }

  const eol = parsed.fmBlock.includes('\r\n') ? '\r\n' : '\n';
  const lines = parsed.fmBlock.split(/\r?\n/);
  const closingFence = lines.length - (lines.at(-1) === '' ? 2 : 1);

  for (const [key, value] of entries) {
    const rendered = renderValue(key, value);
    const at = lines.findIndex((line, i) => i > 0 && i < closingFence && line.startsWith(`${key}:`));

    if (at === -1) {
      lines.splice(closingFence, 0, rendered);
    } else {
      lines[at] = rendered;
      // A replaced inline `tags:` must not leave its old block-list items behind.
      if (key === 'tags') {
        let next = at + 1;
        while (next < lines.length && /^\s*-\s+/.test(lines[next] ?? '')) lines.splice(next, 1);
      }
    }
  }

  return lines.join(eol) + parsed.body;
}

export function resolveTitle(path: string, parsed: ParsedNote): string {
  if (parsed.fields.title) return parsed.fields.title;
  const h1 = /^#[ \t]+(.+)$/m.exec(parsed.body);
  if (h1?.[1]) return h1[1].trim();
  return noteStem(path).split('/').at(-1) ?? path;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/frontmatter.test.ts`
Expected: PASS — 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/frontmatter.ts test/frontmatter.test.ts
git commit -m "feat: lossless frontmatter parse, patch, and serialize"
```

---

### Task 6: GitHub REST client

Transport only — no caching, no queue, no app logic. Those belong to `sync.ts` and plan 2.

**Files:**
- Create: `src/lib/github.ts`
- Test: `test/github.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class GitHubError extends Error { status: number }`
  - `interface RepoInfo { defaultBranch: string; canPush: boolean; isPrivate: boolean; tokenIsClassic: boolean }`
  - `interface TreeEntry { path: string; sha: string; size: number }`
  - `interface GitHubClientOptions { token: () => string; owner: string; repo: string }`
  - `interface GitHubClient { getRepo(); getTree(branch); getBlob(sha) }`
  - `createClient(options: GitHubClientOptions): GitHubClient`
  - `bytesToBase64(bytes: Uint8Array): string`
  - `base64ToBytes(b64: string): Uint8Array`

- [ ] **Step 1: Write the failing tests**

Create `test/github.test.ts`:

```ts
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type GitHubError, base64ToBytes, bytesToBase64, createClient } from '../src/lib/github';

const TOKEN = 'github_pat_11ABCDEF_supersecretvalue';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = () => createClient({ token: () => TOKEN, owner: 'me', repo: 'my-notes' });

describe('base64 helpers', () => {
  it('round-trip arbitrary bytes', () => {
    const bytes = new Uint8Array(1024).map((_, i) => i % 256);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('handle payloads far larger than the argument limit of String.fromCharCode', () => {
    const bytes = new Uint8Array(500_000).fill(65);
    expect(base64ToBytes(bytesToBase64(bytes))).toHaveLength(500_000);
  });

  it('round-trip multi-byte UTF-8 note content', () => {
    const source = '# Baslik\n\nemoji and accents: café 🎉\n';
    const bytes = new TextEncoder().encode(source);
    expect(new TextDecoder().decode(base64ToBytes(bytesToBase64(bytes)))).toBe(source);
  });
});

describe('getRepo', () => {
  it('reports the default branch, push permission, and privacy', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json({ default_branch: 'trunk', private: true, permissions: { push: true } }),
      ),
    );

    expect(await client().getRepo()).toEqual({
      defaultBranch: 'trunk',
      canPush: true,
      isPrivate: true,
      tokenIsClassic: false,
    });
  });

  it('flags a classic PAT via the X-OAuth-Scopes header', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json(
          { default_branch: 'main', private: true, permissions: { push: true } },
          { headers: { 'X-OAuth-Scopes': 'repo, gist' } },
        ),
      ),
    );

    expect((await client().getRepo()).tokenIsClassic).toBe(true);
  });

  it('sends the token as a bearer credential', async () => {
    let seen: string | null = null;
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', ({ request }) => {
        seen = request.headers.get('authorization');
        return HttpResponse.json({ default_branch: 'main', private: true, permissions: { push: true } });
      }),
    );

    await client().getRepo();
    expect(seen).toBe(`Bearer ${TOKEN}`);
  });
});

describe('error handling', () => {
  it('throws GitHubError carrying the status', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );

    await expect(client().getRepo()).rejects.toMatchObject({ status: 401 });
  });

  it('never leaks the token into the error it throws', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes', () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );

    const error = (await client()
      .getRepo()
      .catch((e: unknown) => e)) as GitHubError;
    const serialised = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`;
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('supersecret');
  });
});

describe('getTree', () => {
  it('returns blob entries and drops directories', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/trees/main', () =>
        HttpResponse.json({
          truncated: false,
          tree: [
            { path: 'work', type: 'tree', sha: 'dir' },
            { path: 'work/a.md', type: 'blob', sha: 'sha-a', size: 10 },
            { path: 'recipes/b.md', type: 'blob', sha: 'sha-b', size: 20 },
          ],
        }),
      ),
    );

    expect(await client().getTree('main')).toEqual([
      { path: 'work/a.md', sha: 'sha-a', size: 10 },
      { path: 'recipes/b.md', sha: 'sha-b', size: 20 },
    ]);
  });

  it('walks per-directory when the recursive tree is truncated', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/trees/:ref', ({ params, request }) => {
        const recursive = new URL(request.url).searchParams.get('recursive');
        if (params.ref === 'main' && recursive) {
          return HttpResponse.json({ truncated: true, tree: [] });
        }
        if (params.ref === 'main') {
          return HttpResponse.json({
            truncated: false,
            tree: [
              { path: 'root.md', type: 'blob', sha: 'sha-root', size: 1 },
              { path: 'work', type: 'tree', sha: 'sha-work' },
            ],
          });
        }
        return HttpResponse.json({
          truncated: false,
          tree: [{ path: 'nested.md', type: 'blob', sha: 'sha-nested', size: 2 }],
        });
      }),
    );

    expect((await client().getTree('main')).map((e) => e.path).sort()).toEqual([
      'root.md',
      'work/nested.md',
    ]);
  });
});

describe('getBlob', () => {
  it('decodes base64 blob content', async () => {
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/blobs/sha-a', () =>
        HttpResponse.json({ encoding: 'base64', content: bytesToBase64(new TextEncoder().encode('hi')) }),
      ),
    );

    expect(new TextDecoder().decode(await client().getBlob('sha-a'))).toBe('hi');
  });

  it('tolerates the newlines GitHub wraps base64 in', async () => {
    const wrapped = bytesToBase64(new TextEncoder().encode('x'.repeat(200))).replace(/(.{60})/g, '$1\n');
    server.use(
      http.get('https://api.github.com/repos/me/my-notes/git/blobs/sha-w', () =>
        HttpResponse.json({ encoding: 'base64', content: wrapped }),
      ),
    );

    expect(await client().getBlob('sha-w')).toHaveLength(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/github.test.ts`
Expected: FAIL — cannot resolve `../src/lib/github`.

- [ ] **Step 3: Implement the client**

Create `src/lib/github.ts`:

```ts
const API = 'https://api.github.com';

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface RepoInfo {
  defaultBranch: string;
  canPush: boolean;
  isPrivate: boolean;
  /** Classic PATs carry account-wide scope; the UI warns about them. */
  tokenIsClassic: boolean;
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface GitHubClientOptions {
  /** A getter, not a value: the token is read per request and never stored here. */
  token: () => string;
  owner: string;
  repo: string;
}

export interface GitHubClient {
  getRepo(): Promise<RepoInfo>;
  getTree(branch: string): Promise<TreeEntry[]>;
  getBlob(sha: string): Promise<Uint8Array>;
}

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createClient(options: GitHubClientOptions): GitHubClient {
  const base = `${API}/repos/${options.owner}/${options.repo}`;

  async function request(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${options.token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      // The thrown TypeError can echo the request; never re-expose it.
      throw new GitHubError(0, 'Could not reach GitHub. Check your connection.');
    }

    if (!response.ok) {
      // Only GitHub's own message is surfaced - never headers, never the URL.
      const message = await response
        .json()
        .then((b: unknown) => (b as { message?: string })?.message)
        .catch(() => undefined);
      throw new GitHubError(response.status, message ?? `GitHub returned ${response.status}.`);
    }

    return response;
  }

  async function readTree(ref: string, recursive: boolean) {
    const url = `${base}/git/trees/${encodeURIComponent(ref)}${recursive ? '?recursive=1' : ''}`;
    return (await request(url)).json() as Promise<{
      truncated: boolean;
      tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    }>;
  }

  /** Very large vaults truncate the recursive tree; fall back to a breadth-first walk. */
  async function walk(ref: string, prefix: string): Promise<TreeEntry[]> {
    const { tree } = await readTree(ref, false);
    const entries: TreeEntry[] = [];

    for (const node of tree) {
      const path = prefix ? `${prefix}/${node.path}` : node.path;
      if (node.type === 'blob') {
        entries.push({ path, sha: node.sha, size: node.size ?? 0 });
      } else if (node.type === 'tree') {
        entries.push(...(await walk(node.sha, path)));
      }
    }

    return entries;
  }

  return {
    async getRepo() {
      const response = await request(base);
      const body = (await response.json()) as {
        default_branch: string;
        private: boolean;
        permissions?: { push?: boolean };
      };
      return {
        defaultBranch: body.default_branch,
        canPush: body.permissions?.push === true,
        isPrivate: body.private,
        tokenIsClassic: response.headers.get('x-oauth-scopes') !== null,
      };
    },

    async getTree(branch) {
      const recursive = await readTree(branch, true);
      if (!recursive.truncated) {
        return recursive.tree
          .filter((n) => n.type === 'blob')
          .map((n) => ({ path: n.path, sha: n.sha, size: n.size ?? 0 }));
      }
      return walk(branch, '');
    },

    async getBlob(sha) {
      const body = (await (await request(`${base}/git/blobs/${sha}`)).json()) as {
        content: string;
        encoding: string;
      };
      if (body.encoding !== 'base64') {
        throw new GitHubError(0, `Unexpected blob encoding "${body.encoding}".`);
      }
      return base64ToBytes(body.content);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/github.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/github.ts test/github.test.ts
git commit -m "feat: GitHub REST client with token redaction and truncated-tree fallback"
```

---

### Task 7: Session — unlock, lock, and the idle timer

**Files:**
- Create: `src/lib/session.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: `crypto.ts` (`deriveKey`, `encrypt`, `decrypt`, `randomBytes`, `SALT_BYTES`), `db.ts` (`readSecret`, `writeSecret`, `destroyVaultDB`, `TopaziusDB`)
- Produces:
  - `type SessionState = 'empty' | 'locked' | 'unlocked'`
  - `interface SessionDeps { db: IDBPDatabase<TopaziusDB>; idleMinutes?: number }`
  - `createSession(deps: SessionDeps): Session`
  - `Session.state(): SessionState`
  - `Session.enroll(token: string, passphrase: string): Promise<void>`
  - `Session.unlock(passphrase: string): Promise<void>`
  - `Session.lock(): void`
  - `Session.getToken(): string` — throws when locked
  - `Session.getKey(): CryptoKey` — throws when locked
  - `Session.touch(): void`
  - `Session.onChange(listener: () => void): () => void`
  - `Session.logout(): Promise<void>`
  - `MIN_PASSPHRASE_LENGTH`, `SECRET_VERSION`

- [ ] **Step 1: Write the failing tests**

Create `test/session.test.ts`:

```ts
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TopaziusDB, destroyVaultDB, openVaultDB, readSecret } from '../src/lib/db';
import { MIN_PASSPHRASE_LENGTH, createSession } from '../src/lib/session';

const TOKEN = 'github_pat_11ABCDEF_supersecretvalue';
const PASS = 'correct horse battery';

let db: IDBPDatabase<TopaziusDB>;

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  db.close();
  await destroyVaultDB();
  vi.useRealTimers();
});

const session = (idleMinutes = 15) => createSession({ db, idleMinutes });

/** The empty-vs-locked distinction needs one async storage probe to settle. */
function settled(s: ReturnType<typeof session>): Promise<void> {
  return new Promise((resolve) => {
    const stop = s.onChange(() => {
      stop();
      resolve();
    });
  });
}

describe('enrolment', () => {
  it('starts empty before a token is enrolled', async () => {
    const s = session();
    await settled(s);
    expect(s.state()).toBe('empty');
  });

  it('stores the token encrypted, never in the clear', async () => {
    await session().enroll(TOKEN, PASS);

    const stored = await readSecret(db);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored!.ct)).not.toContain('supersecret');
    expect(JSON.stringify(Array.from(stored!.ct))).not.toContain(TOKEN);
  });

  it('leaves the session unlocked after enrolling', async () => {
    const s = session();
    await s.enroll(TOKEN, PASS);
    expect(s.state()).toBe('unlocked');
    expect(s.getToken()).toBe(TOKEN);
  });

  it('rejects a passphrase below the minimum length', async () => {
    await expect(session().enroll(TOKEN, 'short')).rejects.toThrow(/at least/i);
    expect(MIN_PASSPHRASE_LENGTH).toBe(10);
  });
});

describe('unlock', () => {
  it('recovers the token with the right passphrase', async () => {
    await session().enroll(TOKEN, PASS);

    const fresh = session();
    await fresh.unlock(PASS);
    expect(fresh.getToken()).toBe(TOKEN);
    expect(fresh.state()).toBe('unlocked');
  });

  it('refuses the wrong passphrase and stays locked', async () => {
    await session().enroll(TOKEN, PASS);

    const fresh = session();
    await expect(fresh.unlock('wrong passphrase')).rejects.toThrow();
    expect(fresh.state()).toBe('locked');
  });

  it('refuses to unlock a vault with no enrolled token', async () => {
    await expect(session().unlock(PASS)).rejects.toThrow(/no token/i);
  });
});

describe('lock', () => {
  it('drops the token and the key', async () => {
    const s = session();
    await s.enroll(TOKEN, PASS);
    s.lock();

    expect(s.state()).toBe('locked');
    expect(() => s.getToken()).toThrow(/locked/i);
    expect(() => s.getKey()).toThrow(/locked/i);
  });

  it('locks automatically once the idle timeout elapses', async () => {
    const s = session(15);
    await s.enroll(TOKEN, PASS);
    vi.useFakeTimers();

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(s.state()).toBe('unlocked');

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(s.state()).toBe('locked');
  });

  it('defers the auto-lock when activity is reported', async () => {
    const s = session(15);
    await s.enroll(TOKEN, PASS);
    vi.useFakeTimers();

    vi.advanceTimersByTime(14 * 60 * 1000);
    s.touch();
    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(s.state()).toBe('unlocked');

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(s.state()).toBe('locked');
  });

  it('never auto-locks when the timeout is disabled', async () => {
    const s = session(0);
    await s.enroll(TOKEN, PASS);
    vi.useFakeTimers();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(s.state()).toBe('unlocked');
  });

  it('notifies subscribers when the state changes', async () => {
    const s = session();
    await settled(s);

    const seen = vi.fn();
    const unsubscribe = s.onChange(seen);

    await s.enroll(TOKEN, PASS);
    s.lock();
    expect(seen).toHaveBeenCalledTimes(2);

    unsubscribe();
    await s.unlock(PASS);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('logout', () => {
  it('destroys the database and returns to empty', async () => {
    const s = session();
    await s.enroll(TOKEN, PASS);
    await s.logout();

    expect(s.state()).toBe('empty');
    const reopened = await openVaultDB();
    expect(await readSecret(reopened)).toBeUndefined();
    reopened.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — cannot resolve `../src/lib/session`.

- [ ] **Step 3: Implement the session**

Create `src/lib/session.ts`:

```ts
import type { IDBPDatabase } from 'idb';
import { SALT_BYTES, decrypt, deriveKey, encrypt, randomBytes } from './crypto';
import { type TopaziusDB, destroyVaultDB, readSecret, writeSecret } from './db';

export const MIN_PASSPHRASE_LENGTH = 10;
export const SECRET_VERSION = 1;

export type SessionState = 'empty' | 'locked' | 'unlocked';

export interface SessionDeps {
  db: IDBPDatabase<TopaziusDB>;
  /** 0 disables the idle lock. Default 15, per spec §5.3. */
  idleMinutes?: number;
}

export interface Session {
  state(): SessionState;
  enroll(token: string, passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
  getToken(): string;
  getKey(): CryptoKey;
  touch(): void;
  onChange(listener: () => void): () => void;
  logout(): Promise<void>;
}

export function createSession(deps: SessionDeps): Session {
  const idleMs = (deps.idleMinutes ?? 15) * 60_000;

  // The only place the key and token live. Never stored, never handed to the UI.
  let key: CryptoKey | null = null;
  let token: string | null = null;
  let hasSecret: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((listener) => listener());

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function armTimer() {
    clearTimer();
    if (idleMs > 0) timer = setTimeout(lock, idleMs);
  }

  function lock() {
    clearTimer();
    if (key === null && token === null) return;
    key = null;
    token = null;
    notify();
  }

  async function derive(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    }
    return deriveKey(passphrase, salt);
  }

  // Resolve 'empty' vs 'locked' as soon as storage answers.
  void readSecret(deps.db).then((stored) => {
    if (hasSecret === null) {
      hasSecret = stored !== undefined;
      notify();
    }
  });

  return {
    state() {
      if (key !== null) return 'unlocked';
      return hasSecret === false ? 'empty' : 'locked';
    },

    async enroll(newToken, passphrase) {
      const salt = randomBytes(SALT_BYTES);
      const derived = await derive(passphrase, salt);
      const blob = await encrypt(derived, new TextEncoder().encode(newToken));

      await writeSecret(deps.db, { v: SECRET_VERSION, salt, iv: blob.iv, ct: blob.ct });

      key = derived;
      token = newToken;
      hasSecret = true;
      armTimer();
      notify();
    },

    async unlock(passphrase) {
      const stored = await readSecret(deps.db);
      if (!stored) throw new Error('No token is enrolled on this device.');

      const derived = await derive(passphrase, stored.salt);
      // AES-GCM's auth tag is the verifier: a wrong passphrase throws here.
      const plaintext = await decrypt(derived, { iv: stored.iv, ct: stored.ct });

      key = derived;
      token = new TextDecoder().decode(plaintext);
      hasSecret = true;
      armTimer();
      notify();
    },

    lock,

    getToken() {
      if (token === null) throw new Error('Vault is locked.');
      return token;
    },

    getKey() {
      if (key === null) throw new Error('Vault is locked.');
      return key;
    },

    touch() {
      if (key !== null) armTimer();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async logout() {
      clearTimer();
      key = null;
      token = null;
      hasSecret = false;
      await destroyVaultDB();
      notify();
    },
  };
}
```

`state()` reports `'locked'` until that one storage probe resolves, then flips to
`'empty'` if nothing is enrolled. Callers that must distinguish the two before
rendering wait for the first `onChange`, which is what the test helper does.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session.test.ts`
Expected: PASS — 13 tests.

Note: `enroll` and `unlock` each derive a key at 600000 iterations, so this file takes several seconds. The timer tests install fake timers only *after* enrolment, because PBKDF2 is a real async operation that fake timers would otherwise stall.

- [ ] **Step 5: Commit**

```bash
git add src/lib/session.ts test/session.test.ts
git commit -m "feat: session with encrypted token enrolment, unlock, and idle lock"
```

---

### Task 8: Vault load — tree diff and blob hydration

**Files:**
- Create: `src/lib/concurrency.ts`, `src/lib/sync.ts`
- Test: `test/concurrency.test.ts`, `test/sync.test.ts`

**Interfaces:**
- Consumes: `github.ts` (`GitHubClient`, `TreeEntry`), `db.ts`, `crypto.ts` (`encrypt`, `decrypt`), `paths.ts` (`isNotePath`, `isReservedPath`)
- Produces:
  - `BLOB_CONCURRENCY`
  - `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>`
  - `interface LoadProgress { fetched: number; total: number; path: string }`
  - `interface LoadDeps { gh: GitHubClient; db: IDBPDatabase<TopaziusDB>; key: CryptoKey; branch: string; onProgress?: (p: LoadProgress) => void }`
  - `loadVault(deps: LoadDeps): Promise<string[]>` — returns every note path in the vault
  - `readNoteText(db: IDBPDatabase<TopaziusDB>, key: CryptoKey, path: string): Promise<string>`

- [ ] **Step 1: Write the failing concurrency tests**

Create `test/concurrency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/lib/concurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 6, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    });

    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 6, async (x) => x)).toEqual([]);
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run the concurrency tests to verify they fail**

Run: `npx vitest run test/concurrency.test.ts`
Expected: FAIL — cannot resolve `../src/lib/concurrency`.

- [ ] **Step 3: Implement the concurrency helper**

Create `src/lib/concurrency.ts`:

```ts
/** Blob fetch concurrency cap, per spec §7.1. */
export const BLOB_CONCURRENCY = 6;

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```

- [ ] **Step 4: Run the concurrency tests to verify they pass**

Run: `npx vitest run test/concurrency.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write the failing sync tests**

Create `test/sync.test.ts`:

```ts
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SALT_BYTES, deriveKey, randomBytes } from '../src/lib/crypto';
import { type TopaziusDB, allNotes, destroyVaultDB, openVaultDB, writeNote } from '../src/lib/db';
import type { TreeEntry } from '../src/lib/github';
import { loadVault, readNoteText } from '../src/lib/sync';

let db: IDBPDatabase<TopaziusDB>;
let key: CryptoKey;

beforeEach(async () => {
  db = await openVaultDB();
  key = await deriveKey('a passphrase for tests', randomBytes(SALT_BYTES));
});

afterEach(async () => {
  db.close();
  await destroyVaultDB();
});

function fakeGitHub(tree: TreeEntry[], blobs: Record<string, string>) {
  return {
    getRepo: vi.fn(),
    getTree: vi.fn(async () => tree),
    getBlob: vi.fn(async (sha: string) => new TextEncoder().encode(blobs[sha] ?? '')),
  };
}

describe('loadVault', () => {
  it('caches every note in the tree and returns their paths', async () => {
    const gh = fakeGitHub(
      [
        { path: 'work/a.md', sha: 'sha-a', size: 5 },
        { path: 'recipes/b.md', sha: 'sha-b', size: 5 },
      ],
      { 'sha-a': '# A', 'sha-b': '# B' },
    );

    const paths = await loadVault({ gh, db, key, branch: 'main' });

    expect(paths.sort()).toEqual(['recipes/b.md', 'work/a.md']);
    expect(await readNoteText(db, key, 'work/a.md')).toBe('# A');
  });

  it('stores note bodies encrypted, not in the clear', async () => {
    const gh = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 5 }], { 'sha-a': 'SECRET BODY' });
    await loadVault({ gh, db, key, branch: 'main' });

    const [record] = await allNotes(db);
    expect(new TextDecoder().decode(record!.enc.ct)).not.toContain('SECRET BODY');
  });

  it('skips reserved directories and non-note files', async () => {
    const gh = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a', size: 1 },
        { path: 'assets/2026/08/pic.png', sha: 'sha-p', size: 1 },
        { path: '.topazius/vault.json', sha: 'sha-v', size: 1 },
        { path: 'README.txt', sha: 'sha-r', size: 1 },
      ],
      { 'sha-a': 'A' },
    );

    expect(await loadVault({ gh, db, key, branch: 'main' })).toEqual(['a.md']);
    expect(gh.getBlob).toHaveBeenCalledTimes(1);
  });

  it('includes encrypted notes in the listing', async () => {
    const gh = fakeGitHub([{ path: 'journal/x.md.enc', sha: 'sha-x', size: 9 }], { 'sha-x': 'TPZ1.a.b' });
    expect(await loadVault({ gh, db, key, branch: 'main' })).toEqual(['journal/x.md.enc']);
  });

  it('refetches only blobs whose sha changed', async () => {
    const first = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a1', size: 1 },
        { path: 'b.md', sha: 'sha-b1', size: 1 },
      ],
      { 'sha-a1': 'A1', 'sha-b1': 'B1' },
    );
    await loadVault({ gh: first, db, key, branch: 'main' });
    expect(first.getBlob).toHaveBeenCalledTimes(2);

    const second = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a1', size: 1 },
        { path: 'b.md', sha: 'sha-b2', size: 1 },
      ],
      { 'sha-b2': 'B2' },
    );
    await loadVault({ gh: second, db, key, branch: 'main' });

    expect(second.getBlob).toHaveBeenCalledTimes(1);
    expect(second.getBlob).toHaveBeenCalledWith('sha-b2');
    expect(await readNoteText(db, key, 'b.md')).toBe('B2');
    expect(await readNoteText(db, key, 'a.md')).toBe('A1');
  });

  it('evicts notes that disappeared from the remote', async () => {
    const first = fakeGitHub([{ path: 'gone.md', sha: 'sha-g', size: 1 }], { 'sha-g': 'G' });
    await loadVault({ gh: first, db, key, branch: 'main' });

    const second = fakeGitHub([], {});
    expect(await loadVault({ gh: second, db, key, branch: 'main' })).toEqual([]);
    expect(await allNotes(db)).toEqual([]);
  });

  it('never discards a note with unsynced local edits', async () => {
    const gh = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 1 }], { 'sha-a': 'REMOTE' });
    await loadVault({ gh, db, key, branch: 'main' });

    const [record] = await allNotes(db);
    await writeNote(db, { ...record!, dirty: true });

    const second = fakeGitHub([{ path: 'a.md', sha: 'sha-changed', size: 1 }], { 'sha-changed': 'NEWER' });
    await loadVault({ gh: second, db, key, branch: 'main' });

    expect(second.getBlob).not.toHaveBeenCalled();
    expect(await readNoteText(db, key, 'a.md')).toBe('REMOTE');
  });

  it('keeps a dirty note that vanished from the remote', async () => {
    const first = fakeGitHub([{ path: 'a.md', sha: 'sha-a', size: 1 }], { 'sha-a': 'MINE' });
    await loadVault({ gh: first, db, key, branch: 'main' });

    const [record] = await allNotes(db);
    await writeNote(db, { ...record!, dirty: true });

    await loadVault({ gh: fakeGitHub([], {}), db, key, branch: 'main' });
    expect(await allNotes(db)).toHaveLength(1);
  });

  it('reports progress as blobs land', async () => {
    const gh = fakeGitHub(
      [
        { path: 'a.md', sha: 'sha-a', size: 1 },
        { path: 'b.md', sha: 'sha-b', size: 1 },
      ],
      { 'sha-a': 'A', 'sha-b': 'B' },
    );
    const seen: number[] = [];
    await loadVault({ gh, db, key, branch: 'main', onProgress: (p) => seen.push(p.fetched) });
    expect(seen).toEqual([1, 2]);
  });
});

describe('readNoteText', () => {
  it('throws for a path that is not cached', async () => {
    await expect(readNoteText(db, key, 'missing.md')).rejects.toThrow(/not cached/i);
  });
});
```

- [ ] **Step 6: Run the sync tests to verify they fail**

Run: `npx vitest run test/sync.test.ts`
Expected: FAIL — cannot resolve `../src/lib/sync`.

- [ ] **Step 7: Implement vault loading**

Create `src/lib/sync.ts`:

```ts
import type { IDBPDatabase } from 'idb';
import { BLOB_CONCURRENCY, mapWithConcurrency } from './concurrency';
import { decrypt, encrypt } from './crypto';
import { type TopaziusDB, allNotes, deleteNote, readNote, writeNote } from './db';
import type { GitHubClient } from './github';
import { isNotePath, isReservedPath } from './paths';

export interface LoadProgress {
  fetched: number;
  total: number;
  path: string;
}

export interface LoadDeps {
  gh: GitHubClient;
  db: IDBPDatabase<TopaziusDB>;
  key: CryptoKey;
  branch: string;
  onProgress?: (progress: LoadProgress) => void;
}

/**
 * Bring the local cache in line with the remote tree and return every note path.
 * Only blobs whose sha changed are fetched. Notes with unsynced local edits are
 * never overwritten or evicted - plan 2's conflict flow owns those.
 */
export async function loadVault(deps: LoadDeps): Promise<string[]> {
  const entries = (await deps.gh.getTree(deps.branch)).filter(
    (entry) => isNotePath(entry.path) && !isReservedPath(entry.path),
  );

  const remotePaths = new Set(entries.map((entry) => entry.path));
  for (const cached of await allNotes(deps.db)) {
    if (!remotePaths.has(cached.path) && !cached.dirty) {
      await deleteNote(deps.db, cached.path);
    }
  }

  const stale: typeof entries = [];
  for (const entry of entries) {
    const cached = await readNote(deps.db, entry.path);
    if (cached?.dirty) continue;
    if (cached?.sha !== entry.sha) stale.push(entry);
  }

  let fetched = 0;
  await mapWithConcurrency(stale, BLOB_CONCURRENCY, async (entry) => {
    const bytes = await deps.gh.getBlob(entry.sha);
    await writeNote(deps.db, {
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
      enc: await encrypt(deps.key, bytes),
      mtime: Date.now(),
      dirty: false,
    });
    fetched++;
    deps.onProgress?.({ fetched, total: stale.length, path: entry.path });
  });

  return entries.map((entry) => entry.path);
}

export async function readNoteText(
  db: IDBPDatabase<TopaziusDB>,
  key: CryptoKey,
  path: string,
): Promise<string> {
  const record = await readNote(db, path);
  if (!record) throw new Error(`Note "${path}" is not cached.`);
  return new TextDecoder().decode(await decrypt(key, record.enc));
}
```

- [ ] **Step 8: Run the sync tests to verify they pass**

Run: `npx vitest run test/sync.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 9: Commit**

```bash
git add src/lib/concurrency.ts src/lib/sync.ts test/concurrency.test.ts test/sync.test.ts
git commit -m "feat: vault load with sha-based tree diff and encrypted blob cache"
```

---

### Task 9: Tree building

A pure function, kept out of the component so the folder-shaping rules are testable without rendering.

**Files:**
- Create: `src/lib/tree.ts`
- Test: `test/tree.test.ts`

**Interfaces:**
- Consumes: `paths.ts` (`isEncryptedPath`)
- Produces:
  - `interface TreeNode { name: string; path: string; kind: 'folder' | 'note'; encrypted: boolean; children: TreeNode[] }`
  - `buildTree(paths: string[]): TreeNode[]`

- [ ] **Step 1: Write the failing tests**

Create `test/tree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTree } from '../src/lib/tree';

describe('buildTree', () => {
  it('nests notes under their folders', () => {
    const tree = buildTree(['work/standup.md', 'work/roadmap.md', 'inbox/idea.md']);

    expect(tree.map((n) => n.name)).toEqual(['inbox', 'work']);
    expect(tree[1]?.kind).toBe('folder');
    expect(tree[1]?.children.map((n) => n.name)).toEqual(['roadmap', 'standup']);
  });

  it('sorts folders before notes, each alphabetically', () => {
    const tree = buildTree(['zebra.md', 'work/a.md', 'apple.md', 'archive/b.md']);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'folder:archive',
      'folder:work',
      'note:apple',
      'note:zebra',
    ]);
  });

  it('handles arbitrarily deep nesting', () => {
    const tree = buildTree(['a/b/c/deep.md']);
    expect(tree[0]?.children[0]?.children[0]?.children[0]).toMatchObject({
      name: 'deep',
      path: 'a/b/c/deep.md',
      kind: 'note',
    });
  });

  it('strips both note extensions from display names and flags encrypted notes', () => {
    const tree = buildTree(['plain.md', 'sealed.md.enc']);
    expect(tree.map((n) => [n.name, n.encrypted])).toEqual([
      ['plain', false],
      ['sealed', true],
    ]);
  });

  it('gives folders their own vault-relative path', () => {
    const tree = buildTree(['a/b/c.md']);
    expect(tree[0]?.path).toBe('a');
    expect(tree[0]?.children[0]?.path).toBe('a/b');
  });

  it('reuses one folder node for sibling notes', () => {
    const tree = buildTree(['a/one.md', 'a/two.md']);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(2);
  });

  it('sorts case-insensitively so the tree reads naturally', () => {
    expect(buildTree(['Beta.md', 'alpha.md']).map((n) => n.name)).toEqual(['alpha', 'Beta']);
  });

  it('returns an empty array for an empty vault', () => {
    expect(buildTree([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tree.test.ts`
Expected: FAIL — cannot resolve `../src/lib/tree`.

- [ ] **Step 3: Implement tree building**

Create `src/lib/tree.ts`:

```ts
import { isEncryptedPath } from './paths';

export interface TreeNode {
  /** Display name: the final segment, with .md or .md.enc stripped for notes. */
  name: string;
  /** Vault-relative path. For folders, the path of the folder itself. */
  path: string;
  kind: 'folder' | 'note';
  encrypted: boolean;
  children: TreeNode[];
}

function compare(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function sortDeep(nodes: TreeNode[]): TreeNode[] {
  nodes.sort(compare);
  for (const node of nodes) sortDeep(node.children);
  return nodes;
}

export function buildTree(paths: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();

  for (const path of paths) {
    const segments = path.split('/');
    const fileName = segments.pop();
    if (fileName === undefined) continue;

    let siblings = roots;
    let prefix = '';

    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { name: segment, path: prefix, kind: 'folder', encrypted: false, children: [] };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }

    siblings.push({
      name: fileName.replace(/\.md(\.enc)?$/, ''),
      path,
      kind: 'note',
      encrypted: isEncryptedPath(path),
      children: [],
    });
  }

  return sortDeep(roots);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tree.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tree.ts test/tree.test.ts
git commit -m "feat: build a sorted folder tree from flat note paths"
```

---

### Task 10: Setup screen

**Files:**
- Create: `src/ui/Setup.tsx`, `src/ui/forms.css`
- Test: `test/setup-ui.test.tsx`

**Interfaces:**
- Consumes: `github.ts` (`createClient`, `GitHubError`), `session.ts` (`Session`, `MIN_PASSPHRASE_LENGTH`), `db.ts` (`writeConfig`, `TopaziusDB`)
- Produces:
  - `interface SetupInput { owner: string; repo: string; token: string }`
  - `interface SetupResult { branch: string; warnings: string[] }`
  - `validateSetup(input: SetupInput): Promise<SetupResult>`
  - `interface SetupProps { db: IDBPDatabase<TopaziusDB>; session: Session; onDone: () => void }`
  - `<Setup />`

- [ ] **Step 1: Install the testing library**

```bash
npm install -D @testing-library/preact @testing-library/user-event @testing-library/jest-dom
```

Then add the matchers to `test/setup.ts` by appending:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 2: Write the failing tests**

Create `test/setup-ui.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { IDBPDatabase } from 'idb';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TopaziusDB, destroyVaultDB, openVaultDB, readConfig } from '../src/lib/db';
import { createSession } from '../src/lib/session';
import { Setup, validateSetup } from '../src/ui/Setup';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let db: IDBPDatabase<TopaziusDB>;

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  cleanup();
  server.resetHandlers();
  db.close();
  await destroyVaultDB();
});

function repoResponds(body: unknown, init?: ResponseInit) {
  server.use(http.get('https://api.github.com/repos/me/my-notes', () => HttpResponse.json(body, init)));
}

async function fillForm(passphrase: string, confirm = passphrase) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/owner/i), 'me');
  await user.type(screen.getByLabelText(/repository name/i), 'my-notes');
  await user.type(screen.getByLabelText(/access token/i), 'github_pat_x');
  await user.type(screen.getByLabelText(/^passphrase/i), passphrase);
  await user.type(screen.getByLabelText(/confirm/i), confirm);
  await user.click(screen.getByRole('button', { name: /unlock vault/i }));
}

describe('validateSetup', () => {
  it('returns the default branch with no warnings for a well-scoped token', async () => {
    repoResponds({ default_branch: 'trunk', private: true, permissions: { push: true } });

    expect(await validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' })).toEqual({
      branch: 'trunk',
      warnings: [],
    });
  });

  it('warns when the token is a classic PAT', async () => {
    repoResponds(
      { default_branch: 'main', private: true, permissions: { push: true } },
      { headers: { 'X-OAuth-Scopes': 'repo' } },
    );

    const result = await validateSetup({ owner: 'me', repo: 'my-notes', token: 'ghp_x' });
    expect(result.warnings.join(' ')).toMatch(/classic/i);
  });

  it('warns when the repository is public', async () => {
    repoResponds({ default_branch: 'main', private: false, permissions: { push: true } });

    const result = await validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' });
    expect(result.warnings.join(' ')).toMatch(/public/i);
  });

  it('rejects a token without write access', async () => {
    repoResponds({ default_branch: 'main', private: true, permissions: { push: false } });

    await expect(validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' })).rejects.toThrow(
      /write/i,
    );
  });

  it('turns a 404 into guidance about the repo name and token scope', async () => {
    repoResponds({ message: 'Not Found' }, { status: 404 });

    await expect(validateSetup({ owner: 'me', repo: 'my-notes', token: 'github_pat_x' })).rejects.toThrow(
      /could not find/i,
    );
  });

  it('turns a 401 into guidance about the token itself', async () => {
    repoResponds({ message: 'Bad credentials' }, { status: 401 });

    await expect(validateSetup({ owner: 'me', repo: 'my-notes', token: 'bad' })).rejects.toThrow(
      /rejected that token/i,
    );
  });
});

describe('<Setup />', () => {
  it('enrols the token and stores the resolved branch on success', async () => {
    repoResponds({ default_branch: 'trunk', private: true, permissions: { push: true } });
    const session = createSession({ db });
    const onDone = vi.fn();

    render(<Setup db={db} session={session} onDone={onDone} />);
    await fillForm('a good long passphrase');

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await readConfig(db)).toMatchObject({ owner: 'me', repo: 'my-notes', branch: 'trunk' });
    expect(session.state()).toBe('unlocked');
  });

  it('refuses mismatched passphrases', async () => {
    const session = createSession({ db });

    render(<Setup db={db} session={session} onDone={vi.fn()} />);
    await fillForm('a good long passphrase', 'a different passphrase');

    expect(await screen.findByRole('alert')).toHaveTextContent(/match/i);
    expect(session.state()).not.toBe('unlocked');
  });

  it('refuses a passphrase below the minimum length', async () => {
    render(<Setup db={db} session={createSession({ db })} onDone={vi.fn()} />);
    await fillForm('short');

    expect(await screen.findByRole('alert')).toHaveTextContent(/10 characters/i);
  });

  it('surfaces a validation failure without enrolling anything', async () => {
    repoResponds({ message: 'Bad credentials' }, { status: 401 });
    const session = createSession({ db });

    render(<Setup db={db} session={session} onDone={vi.fn()} />);
    await fillForm('a good long passphrase');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(session.state()).not.toBe('unlocked');
    expect(await readConfig(db)).toBeUndefined();
  });

  it('warns that the passphrase cannot be recovered', () => {
    render(<Setup db={db} session={createSession({ db })} onDone={vi.fn()} />);
    expect(document.body.textContent).toMatch(/cannot be recovered/i);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/setup-ui.test.tsx`
Expected: FAIL — cannot resolve `../src/ui/Setup`.

- [ ] **Step 4: Implement the setup screen**

Create `src/ui/Setup.tsx`:

```tsx
import type { IDBPDatabase } from 'idb';
import { useState } from 'preact/hooks';
import { type TopaziusDB, writeConfig } from '../lib/db';
import { GitHubError, createClient } from '../lib/github';
import { MIN_PASSPHRASE_LENGTH, type Session } from '../lib/session';
import './forms.css';

const TOKEN_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens/new';

export interface SetupInput {
  owner: string;
  repo: string;
  token: string;
}

export interface SetupResult {
  branch: string;
  warnings: string[];
}

/** Check the token really reaches the repo, and report anything the user should know. */
export async function validateSetup(input: SetupInput): Promise<SetupResult> {
  const gh = createClient({ token: () => input.token, owner: input.owner, repo: input.repo });

  let info;
  try {
    info = await gh.getRepo();
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new Error(
        'Could not find that repository. Check the name, and check that the token grants access to it.',
      );
    }
    if (error instanceof GitHubError && error.status === 401) {
      throw new Error('GitHub rejected that token. It may be expired or mistyped.');
    }
    throw error;
  }

  if (!info.canPush) {
    throw new Error(
      'That token can read the repository but cannot write to it. Grant Contents: Read and write.',
    );
  }

  const warnings: string[] = [];
  if (info.tokenIsClassic) {
    warnings.push(
      'That is a classic token, which can reach every repository in your account. A fine-grained token scoped to this one repository is safer.',
    );
  }
  if (!info.isPrivate) {
    warnings.push('This repository is public, so anyone can read your notes. Consider making it private.');
  }

  return { branch: info.defaultBranch, warnings };
}

export interface SetupProps {
  db: IDBPDatabase<TopaziusDB>;
  session: Session;
  onDone: () => void;
}

export function Setup({ db, session, onDone }: SetupProps) {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setError(null);
    setWarnings([]);

    if (passphrase !== confirm) {
      setError('The two passphrases do not match.');
      return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      const trimmed = { owner: owner.trim(), repo: repo.trim(), token: token.trim() };
      const result = await validateSetup(trimmed);
      await writeConfig(db, {
        owner: trimmed.owner,
        repo: trimmed.repo,
        branch: result.branch,
        prefs: {},
      });
      await session.enroll(trimmed.token, passphrase);
      setWarnings(result.warnings);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="panel" onSubmit={submit}>
      <h1>Connect your vault</h1>
      <p>
        Your notes live in a private GitHub repository that you own. Topazius talks to it directly from
        this browser, and sends them nowhere else.
      </p>

      <label>
        Repository owner
        <input value={owner} onInput={(e) => setOwner(e.currentTarget.value)} autocomplete="off" required />
      </label>

      <label>
        Repository name
        <input value={repo} onInput={(e) => setRepo(e.currentTarget.value)} autocomplete="off" required />
      </label>

      <label>
        Access token
        <input
          type="password"
          value={token}
          onInput={(e) => setToken(e.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
          required
        />
      </label>
      <p class="hint">
        Create a <strong>fine-grained</strong> token at{' '}
        <a href={TOKEN_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
          github.com/settings/personal-access-tokens
        </a>
        , limited to this one repository, with <strong>Contents: Read and write</strong>. Nothing else is
        needed.
      </p>

      <label>
        Passphrase
        <input
          type="password"
          value={passphrase}
          onInput={(e) => setPassphrase(e.currentTarget.value)}
          autocomplete="new-password"
          required
        />
      </label>

      <label>
        Confirm passphrase
        <input
          type="password"
          value={confirm}
          onInput={(e) => setConfirm(e.currentTarget.value)}
          autocomplete="new-password"
          required
        />
      </label>
      <p class="hint">
        Your token is encrypted with this passphrase and stored only on this device. It{' '}
        <strong>cannot be recovered</strong>: if you forget it, you will enter a new token and choose a new
        passphrase. Your notes stay safe in GitHub either way.
      </p>

      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      {warnings.map((warning) => (
        <p class="warn" key={warning}>
          {warning}
        </p>
      ))}

      <button type="submit" disabled={busy}>
        {busy ? 'Checking...' : 'Unlock vault'}
      </button>
    </form>
  );
}
```

Create `src/ui/forms.css`:

```css
.panel {
  max-width: 30rem;
  margin: 4rem auto;
  padding: 0 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.panel label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-weight: 600;
}

.panel input {
  padding: 0.6rem 0.7rem;
  font: inherit;
  font-weight: 400;
  border: 1px solid var(--border, #c9c9c9);
  border-radius: 6px;
}

.panel button {
  padding: 0.7rem 1rem;
  font: inherit;
  font-weight: 600;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.panel button[disabled] {
  cursor: progress;
  opacity: 0.6;
}

.hint {
  margin: 0;
  font-size: 0.875rem;
  opacity: 0.8;
}

.alert,
.warn {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  font-size: 0.9rem;
}

.alert {
  background: #fdeaea;
  color: #8a1c1c;
}

.warn {
  background: #fdf4e3;
  color: #7a5200;
}

.linkish {
  background: none;
  border: 0;
  padding: 0.25rem;
  font-size: 0.875rem;
  text-decoration: underline;
  cursor: pointer;
  opacity: 0.8;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/setup-ui.test.tsx`
Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Setup.tsx src/ui/forms.css test/setup-ui.test.tsx test/setup.ts package.json package-lock.json
git commit -m "feat: setup screen with token validation and passphrase enrolment"
```

---

### Task 11: Lock screen

**Files:**
- Create: `src/ui/Lock.tsx`
- Test: `test/lock-ui.test.tsx`

**Interfaces:**
- Consumes: `session.ts` (`Session`), `db.ts` (`AppConfig`)
- Produces:
  - `interface LockProps { session: Session; config?: AppConfig; onUnlocked: () => void; onForgot: () => void }`
  - `<Lock />`

- [ ] **Step 1: Write the failing tests**

Create `test/lock-ui.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TopaziusDB, destroyVaultDB, openVaultDB } from '../src/lib/db';
import { createSession } from '../src/lib/session';
import { Lock } from '../src/ui/Lock';

let db: IDBPDatabase<TopaziusDB>;

beforeEach(async () => {
  db = await openVaultDB();
});

afterEach(async () => {
  cleanup();
  db.close();
  await destroyVaultDB();
});

describe('<Lock />', () => {
  it('unlocks with the right passphrase', async () => {
    const session = createSession({ db });
    await session.enroll('github_pat_x', 'a good long passphrase');
    session.lock();

    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<Lock session={session} onUnlocked={onUnlocked} onForgot={vi.fn()} />);

    await user.type(screen.getByLabelText(/passphrase/i), 'a good long passphrase');
    await user.click(screen.getByRole('button', { name: /^unlock/i }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(session.state()).toBe('unlocked');
  });

  it('reports a wrong passphrase and stays locked', async () => {
    const session = createSession({ db });
    await session.enroll('github_pat_x', 'a good long passphrase');
    session.lock();

    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<Lock session={session} onUnlocked={onUnlocked} onForgot={vi.fn()} />);

    await user.type(screen.getByLabelText(/passphrase/i), 'not the passphrase');
    await user.click(screen.getByRole('button', { name: /^unlock/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/passphrase/i);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(session.state()).toBe('locked');
  });

  it('names the repository it is about to open', () => {
    render(
      <Lock
        session={createSession({ db })}
        config={{ owner: 'me', repo: 'my-notes', branch: 'main', prefs: {} }}
        onUnlocked={vi.fn()}
        onForgot={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain('me/my-notes');
  });

  it('offers a way out for a forgotten passphrase', async () => {
    const onForgot = vi.fn();
    const user = userEvent.setup();
    render(<Lock session={createSession({ db })} onUnlocked={vi.fn()} onForgot={onForgot} />);

    await user.click(screen.getByRole('button', { name: /forgot/i }));
    expect(onForgot).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/lock-ui.test.tsx`
Expected: FAIL — cannot resolve `../src/ui/Lock`.

- [ ] **Step 3: Implement the lock screen**

Create `src/ui/Lock.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { AppConfig } from '../lib/db';
import type { Session } from '../lib/session';
import './forms.css';

export interface LockProps {
  session: Session;
  config?: AppConfig;
  onUnlocked: () => void;
  onForgot: () => void;
}

export function Lock({ session, config, onUnlocked, onForgot }: LockProps) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await session.unlock(passphrase);
      setPassphrase('');
      onUnlocked();
    } catch {
      // Wrong passphrase and corrupt blob mean the same thing at this screen,
      // and distinguishing them would leak nothing useful.
      setError('That passphrase did not unlock this vault.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="panel" onSubmit={submit}>
      <h1>Unlock</h1>
      {config && (
        <p class="hint">
          {config.owner}/{config.repo}
        </p>
      )}

      <label>
        Passphrase
        <input
          type="password"
          value={passphrase}
          onInput={(e) => setPassphrase(e.currentTarget.value)}
          autocomplete="current-password"
          required
        />
      </label>

      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? 'Unlocking...' : 'Unlock'}
      </button>

      <button type="button" class="linkish" onClick={onForgot}>
        I forgot my passphrase
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lock-ui.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Lock.tsx test/lock-ui.test.tsx
git commit -m "feat: lock screen with passphrase unlock"
```

---

### Task 12: Tree, note view, and app wiring

The final task of this plan: the pieces become an app you can unlock and read.

**Files:**
- Create: `src/ui/Tree.tsx`, `src/ui/NoteView.tsx`, `src/ui/Shell.tsx`, `src/ui/shell.css`, `src/app.tsx`
- Modify: `src/main.tsx` (replace the placeholder from Task 1 entirely)
- Test: `test/tree-ui.test.tsx`

**Interfaces:**
- Consumes: `tree.ts` (`buildTree`, `TreeNode`), `sync.ts` (`loadVault`, `readNoteText`), `frontmatter.ts` (`parseNote`, `resolveTitle`), `paths.ts` (`isEncryptedPath`), `session.ts` (`createSession`, `Session`), `db.ts` (`openVaultDB`, `readConfig`, `AppConfig`), `github.ts` (`createClient`)
- Produces:
  - `interface TreeProps { paths: string[]; selected: string | null; onSelect: (path: string) => void }`, `<Tree />`
  - `interface NoteViewProps { db; encryptionKey: CryptoKey; path: string | null }`, `<NoteView />`
  - `interface ShellProps { sidebar; main; status; onLock: () => void }`, `<Shell />`
  - `interface AppProps { db: IDBPDatabase<TopaziusDB> }`, `<App />`

- [ ] **Step 1: Write the failing tree tests**

Create `test/tree-ui.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tree } from '../src/ui/Tree';

afterEach(cleanup);

const PATHS = ['work/standup.md', 'work/roadmap.md', 'journal/aug27.md.enc', 'inbox.md'];

describe('<Tree />', () => {
  it('exposes tree semantics to assistive technology', () => {
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  it('marks encrypted notes', () => {
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('aug27').closest('[role="treeitem"]')?.textContent).toContain('enc');
  });

  it('selects a note when clicked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Tree paths={PATHS} selected={null} onSelect={onSelect} />);

    await user.click(screen.getByText('standup'));
    expect(onSelect).toHaveBeenCalledWith('work/standup.md');
  });

  it('collapses and expands a folder', async () => {
    const user = userEvent.setup();
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText('standup')).toBeInTheDocument();
    await user.click(screen.getByText('work'));
    expect(screen.queryByText('standup')).toBeNull();

    await user.click(screen.getByText('work'));
    expect(screen.getByText('standup')).toBeInTheDocument();
  });

  it('reports the selected note as the active treeitem', () => {
    render(<Tree paths={PATHS} selected="work/standup.md" onSelect={vi.fn()} />);
    expect(screen.getByText('standup').closest('[role="treeitem"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('says so when the vault has no notes yet', () => {
    render(<Tree paths={[]} selected={null} onSelect={vi.fn()} />);
    expect(document.body.textContent).toMatch(/no notes/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tree-ui.test.tsx`
Expected: FAIL — cannot resolve `../src/ui/Tree`.

- [ ] **Step 3: Implement the tree component**

Create `src/ui/Tree.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { type TreeNode, buildTree } from '../lib/tree';

export interface TreeProps {
  paths: string[];
  selected: string | null;
  onSelect: (path: string) => void;
}

interface RowsProps {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}

function Rows({ nodes, depth, collapsed, toggle, selected, onSelect }: RowsProps) {
  return (
    <ul role="group">
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <li key={node.path} role="treeitem" aria-expanded={!collapsed.has(node.path)}>
            <button
              type="button"
              class="row folder"
              style={{ paddingInlineStart: `${depth * 0.85 + 0.5}rem` }}
              onClick={() => toggle(node.path)}
            >
              <span aria-hidden="true">{collapsed.has(node.path) ? '>' : 'v'}</span> {node.name}
            </button>
            {!collapsed.has(node.path) && (
              <Rows
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                toggle={toggle}
                selected={selected}
                onSelect={onSelect}
              />
            )}
          </li>
        ) : (
          <li key={node.path} role="treeitem" aria-selected={selected === node.path}>
            <button
              type="button"
              class={`row note${selected === node.path ? ' selected' : ''}`}
              style={{ paddingInlineStart: `${depth * 0.85 + 1.4}rem` }}
              onClick={() => onSelect(node.path)}
            >
              {node.name}
              {node.encrypted && (
                <span class="badge" title="Encrypted">
                  enc
                </span>
              )}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

export function Tree({ paths, selected, onSelect }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  if (paths.length === 0) {
    return <p class="hint">No notes yet.</p>;
  }

  return (
    <nav role="tree" aria-label="Notes">
      <Rows
        nodes={buildTree(paths)}
        depth={0}
        collapsed={collapsed}
        toggle={toggle}
        selected={selected}
        onSelect={onSelect}
      />
    </nav>
  );
}
```

- [ ] **Step 4: Run the tree tests to verify they pass**

Run: `npx vitest run test/tree-ui.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Implement the note view**

Create `src/ui/NoteView.tsx`:

```tsx
import type { IDBPDatabase } from 'idb';
import { useEffect, useState } from 'preact/hooks';
import type { TopaziusDB } from '../lib/db';
import { parseNote, resolveTitle } from '../lib/frontmatter';
import { isEncryptedPath } from '../lib/paths';
import { readNoteText } from '../lib/sync';

export interface NoteViewProps {
  db: IDBPDatabase<TopaziusDB>;
  encryptionKey: CryptoKey;
  path: string | null;
}

/** Read-only for now; the CodeMirror editor arrives in plan 2. */
export function NoteView({ db, encryptionKey, path }: NoteViewProps) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setText(null);
    setError(null);

    readNoteText(db, encryptionKey, path)
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open that note.');
      });

    return () => {
      cancelled = true;
    };
  }, [db, encryptionKey, path]);

  if (path === null) return <p class="hint">Select a note.</p>;
  if (error)
    return (
      <p class="alert" role="alert">
        {error}
      </p>
    );
  if (text === null) return <p class="hint">Opening...</p>;

  if (isEncryptedPath(path)) {
    return (
      <p class="hint">
        This note is encrypted. Opening sealed notes arrives with the encryption milestone.
      </p>
    );
  }

  const parsed = parseNote(text);
  return (
    <article>
      <h1>{resolveTitle(path, parsed)}</h1>
      <pre class="note-source">{parsed.body}</pre>
    </article>
  );
}
```

- [ ] **Step 6: Implement the shell**

Create `src/ui/Shell.tsx`:

```tsx
import type { ComponentChildren } from 'preact';
import './shell.css';

export interface ShellProps {
  sidebar: ComponentChildren;
  main: ComponentChildren;
  status: ComponentChildren;
  onLock: () => void;
}

export function Shell({ sidebar, main, status, onLock }: ShellProps) {
  return (
    <div class="shell">
      <header class="shell-header">
        <strong>Topazius</strong>
        <span class="shell-status">{status}</span>
        <button type="button" onClick={onLock}>
          Lock
        </button>
      </header>
      <aside class="shell-sidebar">{sidebar}</aside>
      <main class="shell-main">{main}</main>
    </div>
  );
}
```

Create `src/ui/shell.css`:

```css
.shell {
  display: grid;
  grid-template-columns: 16rem 1fr;
  grid-template-rows: auto 1fr;
  grid-template-areas: 'header header' 'sidebar main';
  height: 100dvh;
}

.shell-header {
  grid-area: header;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border, #ddd);
}

.shell-status {
  margin-inline-start: auto;
  font-size: 0.85rem;
  opacity: 0.75;
}

.shell-sidebar {
  grid-area: sidebar;
  overflow: auto;
  border-inline-end: 1px solid var(--border, #ddd);
  padding: 0.5rem 0;
}

.shell-main {
  grid-area: main;
  overflow: auto;
  padding: 1rem 1.5rem;
}

.shell-sidebar ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding-block: 0.28rem;
  font: inherit;
  text-align: start;
  background: none;
  border: 0;
  cursor: pointer;
}

.row.selected {
  background: var(--selected, #e8eefc);
  font-weight: 600;
}

.badge {
  font-size: 0.68rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: var(--border, #ddd);
}

.note-source {
  white-space: pre-wrap;
  font: inherit;
}

@media (max-width: 768px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-areas: 'header' 'sidebar' 'main';
    grid-template-rows: auto auto 1fr;
  }
}
```

- [ ] **Step 7: Wire the app together**

Create `src/app.tsx`:

```tsx
import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { type AppConfig, type TopaziusDB, readConfig } from './lib/db';
import { GitHubError, createClient } from './lib/github';
import { type Session, createSession } from './lib/session';
import { loadVault } from './lib/sync';
import { Lock } from './ui/Lock';
import { NoteView } from './ui/NoteView';
import { Setup } from './ui/Setup';
import { Shell } from './ui/Shell';
import { Tree } from './ui/Tree';

export interface AppProps {
  db: IDBPDatabase<TopaziusDB>;
}

export function App({ db }: AppProps) {
  const [session] = useState<Session>(() => createSession({ db }));
  const [, forceRender] = useState(0);
  const [config, setConfig] = useState<AppConfig | undefined>();
  const [paths, setPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => session.onChange(() => forceRender((n) => n + 1)), [session]);

  useEffect(() => {
    void readConfig(db).then(setConfig);
  }, [db]);

  // Any interaction defers the idle lock.
  useEffect(() => {
    const touch = () => session.touch();
    const events = ['pointerdown', 'keydown'] as const;
    for (const event of events) window.addEventListener(event, touch, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, touch);
    };
  }, [session]);

  // Spec §5.3: lock once the tab has been hidden for five minutes.
  useEffect(() => {
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

    function onVisibilityChange() {
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      hiddenTimer = document.hidden ? setTimeout(() => session.lock(), 5 * 60_000) : null;
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [session]);

  const load = useCallback(async () => {
    const current = await readConfig(db);
    if (!current) return;
    setConfig(current);
    setStatus('Loading...');
    try {
      const gh = createClient({
        token: () => session.getToken(),
        owner: current.owner,
        repo: current.repo,
      });
      const found = await loadVault({
        gh,
        db,
        key: session.getKey(),
        branch: current.branch,
        onProgress: (p) => setStatus(`Loading ${p.fetched}/${p.total}...`),
      });
      setPaths(found);
      setStatus(`${found.length} notes`);
    } catch (error) {
      // Spec §7.2: a 401 means the token is expired or revoked. Lock, so the
      // user is sent back through unlock rather than staring at a dead vault.
      if (error instanceof GitHubError && error.status === 401) {
        session.lock();
        setStatus('GitHub rejected your token. It may be expired or revoked.');
        return;
      }
      setStatus(error instanceof Error ? error.message : 'Could not load the vault.');
    }
  }, [db, session]);

  const state = session.state();

  if (state === 'empty') {
    return <Setup db={db} session={session} onDone={() => void load()} />;
  }

  if (state === 'locked') {
    return (
      <Lock
        session={session}
        config={config}
        onUnlocked={() => void load()}
        onForgot={() => void session.logout()}
      />
    );
  }

  return (
    <Shell
      status={status}
      onLock={() => session.lock()}
      sidebar={<Tree paths={paths} selected={selected} onSelect={setSelected} />}
      main={<NoteView db={db} encryptionKey={session.getKey()} path={selected} />}
    />
  );
}
```

Replace `src/main.tsx` entirely:

```tsx
import { render } from 'preact';
import { App } from './app';
import { openVaultDB } from './lib/db';

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point is missing from index.html');

void openVaultDB().then((db) => render(<App db={db} />, root));
```

- [ ] **Step 8: Verify the whole suite, typecheck, and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests pass, build succeeds.

- [ ] **Step 9: Verify the bundle is within budget**

Run: `cat dist/assets/*.js | gzip -c | wc -c`
Expected: comfortably under 250000 bytes. If it is not, stop and report — the budget is a spec requirement (§15) and CodeMirror still has to fit inside it in plan 2.

- [ ] **Step 10: Manual smoke test against a real vault**

1. Create a private repo on GitHub containing one file, `hello.md`, with the content `# Hello`.
2. Create a fine-grained PAT for that repo with Contents: Read and write.
3. Run `npm run dev` and open the printed URL.
4. Enter owner, repo, token, and a passphrase of at least 10 characters.
5. Confirm the tree lists `hello`, clicking it shows the note, and the header reports `1 notes`.
6. Click **Lock**, then unlock again with the passphrase and confirm the vault reloads.
7. In devtools, Application to IndexedDB to `topazius` to `secret`: confirm the stored value is bytes, not your token.
8. In devtools, Network: confirm every request went to `api.github.com` and nowhere else.
9. Switch to another tab for five minutes, come back, and confirm the vault locked itself.
10. Revoke the PAT on GitHub, reload, unlock, and confirm the app locks again and says the token was rejected rather than hanging.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: shell, folder tree, and read-only note view wired to the vault"
```

---

## Done when

- `npm run typecheck && npm test && npm run build` is clean.
- CI is green, and the Pages deploy succeeds from a fork with assets resolving under `/<repo-name>/`.
- A user can enter owner, repo, token, and passphrase; browse their notes in a folder tree; open one; lock; and unlock again.
- The token is never in storage in plaintext, never in an error message, and never sent anywhere but `api.github.com`.
- Cached note bodies in IndexedDB are ciphertext.

## Not in this plan

Editing, saving, commits, conflict resolution, the offline queue, note creation, rename, move, delete, images, encryption, search, tags, backlinks, the command palette, PWA, and the service worker. Those belong to plans 2-4:

- **Plan 2 — Editing and sync** (spec phases 5-8): CodeMirror 6 with live-preview decorations, the sanitised preview pane, local-first saves, the write queue and commits, the 409 conflict flow, offline behaviour, and the create/rename/move/delete lifecycle.
- **Plan 3 — Images and encryption** (spec phases 9-10): paste and drop upload with canvas downscaling, the blob-URL resolver, then the vault master key, recovery key, note sealing, the per-note toggle, folder defaults, and bulk batches.
- **Plan 4 — Search, mobile, polish** (spec phases 11-13): MiniSearch index, tag sidebar, wikilinks and backlinks, the command palette, responsive layout, PWA manifest and service worker, accessibility pass, and the README with fork instructions.
