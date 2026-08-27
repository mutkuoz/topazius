import type { IDBPDatabase } from 'idb';
import { type Conflict, type ResolutionChoice, resolve as resolveChoice } from './conflict';
import { decrypt, encrypt } from './crypto';
import {
  type AppConfig,
  type TopaziusDB,
  allNotes,
  readAsset,
  readNote,
  writeAsset,
  writeConfig,
} from './db';
import { GitHubError, type GitHubClient, createClient } from './github';
import {
  type PreparedImage,
  type RawImage,
  canvasDownscaler,
  mimeForPath,
  prepareImage,
  resolveAssetPath,
} from './images';
import { type Backlink, buildLinkGraph, resolveLink } from './links';
import { type EncryptionDefault, defaultForFolder, open as openSealed, seal, toggledPath } from './noteenc';
import {
  type NoteDeps,
  conflictsWithExisting,
  markSynced,
  readSource,
  removeNote,
  renameNote,
  validateNotePath,
  writeSource,
} from './notes';
import { isEncryptedPath } from './paths';
import { type Payload, type SyncStatus, type WriteQueue, createQueue } from './queue';
import { type IndexedNote, type VaultSearch, createSearch, indexNote } from './search';
import type { Session } from './session';
import { type LoadFailure, loadVault } from './sync';
import { VAULT_KEY_PATH, type VaultKeyFile, parseVaultKeyFile, serializeVaultKeyFile } from './vaultkey';

/** How long after the last edit the queue is flushed, per spec §3.2. */
export const COMMIT_DEBOUNCE_MS = 10_000;

/** Whether this vault's encrypted notes can be read right now. */
export type SealedState = 'none' | 'locked' | 'open';

export interface VaultState {
  loading: boolean;
  /** Progress, or the reason the last thing failed. */
  message: string;
  status: SyncStatus;
  pending: number;
  paths: string[];
  assets: string[];
  dirty: string[];
  conflicts: string[];
  failures: LoadFailure[];
  /** Sealed or corrupt notes that could not be opened; they render an error card. */
  unreadable: string[];
  sealed: SealedState;
  hasVaultKeyFile: boolean;
}

export interface VaultDeps {
  db: IDBPDatabase<TopaziusDB>;
  session: Session;
  config: AppConfig;
  onChange?: () => void;
  /** Overridden in tests so a save does not wait ten seconds to commit. */
  commitDebounceMs?: number;
  /** Injected by tests; production builds one from the session's token. */
  gh?: GitHubClient;
}

export interface BatchReport {
  done: string[];
  failed: Array<{ path: string; error: string }>;
}

export interface Vault {
  state(): VaultState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  index(): VaultSearch;
  note(path: string): IndexedNote | undefined;
  backlinks(path: string): Backlink[];
  missingLinks(): Map<string, string[]>;
  resolveNoteLink(target: string): string | null;
  read(path: string): Promise<string>;
  save(path: string, text: string): Promise<void>;
  create(path: string, text?: string): Promise<string>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<string>;
  setEncrypted(path: string, encrypted: boolean): Promise<string>;
  encryptFolder(folder: string, encrypted: boolean): Promise<BatchReport>;
  folderDefault(folder: string): EncryptionDefault;
  setFolderDefault(folder: string, value: EncryptionDefault | null): Promise<void>;
  addImage(image: RawImage, notePath: string): Promise<PreparedImage>;
  assetBytes(notePath: string, src: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  flush(): Promise<void>;
  retry(): Promise<void>;
  conflictFor(path: string): Promise<Conflict>;
  resolveConflict(path: string, choice: ResolutionChoice): Promise<void>;
  /** The first-encryption ceremony: makes the key, returns the recovery key once. */
  createVaultKey(passphrase: string): Promise<string>;
  unlockVaultKey(secret: string, which: 'passphrase' | 'recovery'): Promise<void>;
  regenerateRecoveryKey(): Promise<string>;
  keyFile(): VaultKeyFile | null;
  dispose(): void;
}

const utf8 = new TextEncoder();
const aad = (path: string) => utf8.encode(path);

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function createVault(deps: VaultDeps): Vault {
  const listeners = new Set<() => void>();
  const search = createSearch();
  const debounceMs = deps.commitDebounceMs ?? COMMIT_DEBOUNCE_MS;

  let config = deps.config;
  let loading = false;
  let message = '';
  let paths: string[] = [];
  let assets: string[] = [];
  let dirty = new Set<string>();
  let failures: LoadFailure[] = [];
  let unreadable = new Set<string>();
  let keyFile: VaultKeyFile | null = null;
  let links = buildLinkGraph([]);
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const gh =
    deps.gh ??
    createClient({ token: () => deps.session.getToken(), owner: config.owner, repo: config.repo });

  function notify() {
    deps.onChange?.();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('vault listener threw', error);
      }
    }
  }

  /** Note-layer dependencies, re-read per call: key material is never cached here. */
  function noteDeps(): NoteDeps {
    return { db: deps.db, key: deps.session.getKey(), vmk: deps.session.getVaultKey() };
  }

  /**
   * What the queue uploads for a path. Notes and non-note files (images, the
   * wrapped vault key) live in different stores but travel the same road, and
   * both are already in their final on-disk form - sealed where sealing
   * applies - so no plaintext reaches the queue (spec §7.2).
   */
  async function resolvePayload(path: string): Promise<Payload | null> {
    const key = deps.session.getKey();
    const note = await readNote(deps.db, path);
    if (note) return { bytes: await decrypt(key, note.enc, aad(path)), sha: note.sha };
    const asset = await readAsset(deps.db, path);
    if (asset) return { bytes: await decrypt(key, asset.enc, aad(path)), sha: asset.sha };
    return null;
  }

  async function onWritten(path: string, result: { sha: string; size: number }): Promise<void> {
    const note = await readNote(deps.db, path);
    if (note) {
      await markSynced(deps.db, path, result.sha, result.size);
      dirty.delete(path);
      return;
    }
    const asset = await readAsset(deps.db, path);
    if (asset) await writeAsset(deps.db, { ...asset, sha: result.sha });
  }

  const queue: WriteQueue = createQueue({
    db: deps.db,
    gh,
    branch: config.branch,
    resolve: resolvePayload,
    onWritten,
    onConflict: () => notify(),
    onUnauthorized: () => deps.session.lock(),
    onChange: notify,
  });

  function sealedState(): SealedState {
    if (!paths.some(isEncryptedPath) && keyFile === null) return 'none';
    return deps.session.getVaultKey() ? 'open' : 'locked';
  }

  function state(): VaultState {
    const queueState = queue.state();
    return {
      loading,
      message: message || queueState.message,
      status: queueState.status,
      pending: queueState.pending,
      paths,
      assets,
      dirty: [...dirty],
      conflicts: queueState.conflicts,
      failures,
      unreadable: [...unreadable],
      sealed: sealedState(),
      hasVaultKeyFile: keyFile !== null,
    };
  }

  function rebuildLinks(): void {
    links = buildLinkGraph(
      paths.map((path) => ({ path, body: search.get(path)?.body ?? '' })),
    );
  }

  /** Decrypt everything into memory and rebuild the index and link graph (§7.1). */
  async function reindex(): Promise<void> {
    unreadable = new Set();

    for (const path of paths) {
      try {
        search.update(indexNote(path, await readSource(noteDeps(), path)));
      } catch {
        // One unreadable note - sealed with no key at hand, corrupted, or
        // hand-edited - must never stop the vault opening (spec §9.8). It is
        // still listed and still selectable; opening it explains itself.
        unreadable.add(path);
        search.update({
          path,
          title: path.split('/').at(-1) ?? path,
          tags: [],
          body: '',
          encrypted: isEncryptedPath(path),
        });
      }
    }

    for (const stale of search.notes()) {
      if (!paths.includes(stale.path)) search.remove(stale.path);
    }

    rebuildLinks();
  }

  async function refreshDirty(): Promise<void> {
    dirty = new Set((await allNotes(deps.db)).filter((note) => note.dirty).map((note) => note.path));
  }

  /** Read the wrapped vault key from the repo, if the tree says it is there (§9.2). */
  async function loadKeyFile(metaPaths: string[]): Promise<void> {
    if (!metaPaths.includes(VAULT_KEY_PATH)) return;
    try {
      const file = await gh.getFile(VAULT_KEY_PATH, config.branch);
      if (!file) return;
      keyFile = parseVaultKeyFile(file.bytes);
      await writeAsset(deps.db, {
        path: VAULT_KEY_PATH,
        sha: file.sha,
        mime: 'application/json',
        enc: await encrypt(deps.session.getKey(), file.bytes, aad(VAULT_KEY_PATH)),
      });
    } catch (error) {
      failures.push({ path: VAULT_KEY_PATH, error: messageOf(error, 'Could not read the vault key.') });
    }
  }

  function scheduleCommit(): void {
    if (commitTimer !== null) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = null;
      void queue.flush();
    }, debounceMs);
  }

  async function enqueue(path: string): Promise<void> {
    await queue.enqueuePut(path);
    scheduleCommit();
  }

  /** Persist the key file locally and queue it for commit. */
  async function storeKeyFile(file: VaultKeyFile): Promise<void> {
    keyFile = file;
    const existing = await readAsset(deps.db, VAULT_KEY_PATH);
    await writeAsset(deps.db, {
      path: VAULT_KEY_PATH,
      sha: existing?.sha ?? '',
      mime: 'application/json',
      enc: await encrypt(deps.session.getKey(), serializeVaultKeyFile(file), aad(VAULT_KEY_PATH)),
    });
    await enqueue(VAULT_KEY_PATH);
  }

  async function load(): Promise<void> {
    loading = true;
    message = 'Loading…';
    failures = [];
    notify();

    try {
      const result = await loadVault({
        gh,
        db: deps.db,
        key: deps.session.getKey(),
        branch: config.branch,
        onProgress: (progress) => {
          message = `Loading ${progress.fetched}/${progress.total}…`;
          notify();
        },
      });

      paths = result.paths;
      assets = result.assets.map((entry) => entry.path);
      failures = result.failures;
      await loadKeyFile(result.meta.map((entry) => entry.path));
      await refreshDirty();
      await reindex();
      message =
        failures.length > 0
          ? `${paths.length} notes (${failures.length} did not load)`
          : `${paths.length} notes`;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) {
        deps.session.lock();
        message = 'GitHub rejected your token. It may be expired or revoked.';
      } else {
        message = messageOf(error, 'Could not load the vault.');
      }
    } finally {
      loading = false;
      notify();
    }

    // Anything left from a previous session - an offline edit, a failed
    // write - goes out as soon as the vault is open again.
    if ((await queue.count()) > 0) void queue.flush();
  }

  async function save(path: string, text: string): Promise<void> {
    await writeSource(noteDeps(), path, text, { dirty: true });
    dirty.add(path);
    search.update(indexNote(path, text));
    rebuildLinks();
    await enqueue(path);
    notify();
  }

  async function create(path: string, text = ''): Promise<string> {
    const normalized = validateNotePath(path);
    const clash = conflictsWithExisting(normalized, paths);
    if (clash) {
      throw new Error(
        clash === normalized ? `"${normalized}" already exists.` : `"${clash}" is the same note, sealed.`,
      );
    }
    if (isEncryptedPath(normalized) && !deps.session.getVaultKey()) {
      throw new Error('Set up the vault key before creating an encrypted note.');
    }

    await writeSource(noteDeps(), normalized, text, { sha: '', dirty: true });
    paths = [...paths, normalized];
    dirty.add(normalized);
    search.update(indexNote(normalized, text));
    rebuildLinks();
    await enqueue(normalized);
    notify();
    return normalized;
  }

  async function remove(path: string): Promise<void> {
    const sha = await removeNote(noteDeps(), path);
    paths = paths.filter((candidate) => candidate !== path);
    dirty.delete(path);
    search.remove(path);
    rebuildLinks();
    await queue.enqueueDelete(path, sha);
    scheduleCommit();
    notify();
  }

  async function rename(from: string, to: string): Promise<string> {
    const plan = await renameNote(noteDeps(), from, validateNotePath(to));
    paths = [...paths.filter((path) => path !== from), plan.to];
    dirty.delete(from);
    dirty.add(plan.to);
    search.remove(from);

    // The create is queued before the delete, so an interrupted rename leaves
    // two copies rather than none (spec §4.3).
    await queue.enqueuePut(plan.to);
    for (const path of plan.relinked) {
      dirty.add(path);
      await queue.enqueuePut(path);
    }
    await queue.enqueueDelete(from, plan.fromSha);

    await reindex();
    scheduleCommit();
    notify();
    return plan.to;
  }

  async function setEncrypted(path: string, encrypted: boolean): Promise<string> {
    if (isEncryptedPath(path) === encrypted) return path;
    if (encrypted && !deps.session.getVaultKey()) {
      throw new Error('Set up the vault key before encrypting a note.');
    }
    if (!encrypted && !deps.session.getVaultKey()) {
      throw new Error('Unlock the vault key before decrypting a note.');
    }
    return rename(path, toggledPath(path));
  }

  async function conflictFor(path: string): Promise<Conflict> {
    const local = await readSource(noteDeps(), path);
    const remote = await gh.getFile(path, config.branch);
    if (!remote) return { path, local, remote: '', remoteSha: '', remoteMissing: true };

    const remoteText = new TextDecoder().decode(remote.bytes);
    const vmk = deps.session.getVaultKey();
    // The dialog compares plaintext and never shows ciphertext (spec §9.7).
    const shown =
      isEncryptedPath(path) && vmk
        ? new TextDecoder().decode(await openSealed(vmk, path, remoteText))
        : remoteText;

    return { path, local, remote: shown, remoteSha: remote.sha, remoteMissing: false };
  }

  return {
    state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    load,
    index: () => search,
    note: (path) => search.get(path),
    backlinks: (path) => links.backlinks.get(path) ?? [],
    missingLinks: () => links.missing,
    resolveNoteLink: (target) => resolveLink(target, paths),
    read: (path) => readSource(noteDeps(), path),
    save,
    create,
    remove,
    rename,
    setEncrypted,

    async encryptFolder(folder, encrypted) {
      const prefix = folder === '' ? '' : `${folder.replace(/\/+$/, '')}/`;
      const targets = paths.filter(
        (path) => path.startsWith(prefix) && isEncryptedPath(path) !== encrypted,
      );
      const report: BatchReport = { done: [], failed: [] };

      // Sequential on purpose: each note costs a pair of queued commits, and
      // the batch has to stay resumable if it is interrupted (spec §9.5).
      for (const path of targets) {
        try {
          report.done.push(await setEncrypted(path, encrypted));
        } catch (error) {
          report.failed.push({ path, error: messageOf(error, 'Could not change this note.') });
        }
      }

      notify();
      return report;
    },

    folderDefault(folder) {
      return defaultForFolder(
        config.prefs['encryptionDefaults'] as Record<string, EncryptionDefault> | undefined,
        folder,
      );
    },

    async setFolderDefault(folder, value) {
      const key = folder === '' ? '' : `${folder.replace(/\/+$/, '')}/`;
      const defaults = {
        ...((config.prefs['encryptionDefaults'] as Record<string, EncryptionDefault>) ?? {}),
      };
      if (value === null) delete defaults[key];
      else defaults[key] = value;

      config = { ...config, prefs: { ...config.prefs, encryptionDefaults: defaults } };
      await writeConfig(deps.db, config);
      notify();
    },

    async addImage(image, notePath) {
      const prepared = await prepareImage(image, { existing: assets, downscale: canvasDownscaler });

      // An image added to a sealed note inherits that state (spec §8.3).
      const intoSealed = isEncryptedPath(notePath);
      const vmk = deps.session.getVaultKey();
      if (intoSealed && !vmk) {
        throw new Error('Unlock the vault key before adding an image to a sealed note.');
      }

      const path = intoSealed && !prepared.path.endsWith('.enc') ? `${prepared.path}.enc` : prepared.path;
      const bytes =
        intoSealed && vmk ? utf8.encode(await seal(vmk, path, prepared.bytes)) : prepared.bytes;
      const existing = await readAsset(deps.db, path);

      await writeAsset(deps.db, {
        path,
        sha: existing?.sha ?? '',
        mime: prepared.mime,
        enc: await encrypt(deps.session.getKey(), bytes as Uint8Array<ArrayBuffer>, aad(path)),
      });

      if (!assets.includes(path)) assets = [...assets, path];
      await enqueue(path);
      notify();

      return { ...prepared, path, markdown: `![${image.name.replace(/[[\]]/g, '')}](${path})` };
    },

    async assetBytes(notePath, src) {
      const known = new Set(assets);
      const path = resolveAssetPath(notePath, src, known) ?? resolveAssetPath(notePath, `${src}.enc`, known);
      if (!path) return null;

      const mime = mimeForPath(path);
      const cached = await readAsset(deps.db, path);
      let fileBytes: Uint8Array;

      if (cached) {
        fileBytes = await decrypt(deps.session.getKey(), cached.enc, aad(path));
      } else {
        // Not cached yet: fetch once, then keep it encrypted at rest like
        // everything else (spec §6).
        const file = await gh.getFile(path, config.branch);
        if (!file) return null;
        fileBytes = file.bytes;
        await writeAsset(deps.db, {
          path,
          sha: file.sha,
          mime,
          enc: await encrypt(deps.session.getKey(), file.bytes, aad(path)),
        });
      }

      if (!path.endsWith('.enc')) return { bytes: fileBytes, mime };

      const vmk = deps.session.getVaultKey();
      if (!vmk) throw new Error('This image is sealed. Unlock the vault key to see it.');
      return { bytes: await openSealed(vmk, path, new TextDecoder().decode(fileBytes)), mime };
    },

    async flush() {
      if (commitTimer !== null) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
      await queue.flush();
      await refreshDirty();
      notify();
    },

    async retry() {
      await queue.retryAll();
      await queue.flush();
      await refreshDirty();
      notify();
    },

    conflictFor,

    async resolveConflict(path, choice) {
      const conflict = await conflictFor(path);
      const resolution = resolveChoice(conflict, choice);

      await writeSource(noteDeps(), path, resolution.text, {
        sha: resolution.sha,
        dirty: resolution.upload,
      });
      search.update(indexNote(path, resolution.text));
      rebuildLinks();
      queue.clearConflict(path);

      if (resolution.upload) {
        dirty.add(path);
        await queue.enqueuePut(path);
        await queue.flush();
      } else {
        dirty.delete(path);
      }

      await refreshDirty();
      notify();
    },

    async createVaultKey(passphrase) {
      const created = await deps.session.createVaultKey(passphrase);
      await storeKeyFile(created.file);
      notify();
      return created.recoveryKey;
    },

    async unlockVaultKey(secret, which) {
      if (!keyFile) throw new Error('This vault has no key file yet.');
      await deps.session.openVaultKey(keyFile, secret, which);
      await reindex();
      notify();
    },

    async regenerateRecoveryKey() {
      if (!keyFile) throw new Error('This vault has no key file yet.');
      const updated = await deps.session.regenerateRecoveryKey(keyFile);
      await storeKeyFile(updated.file);
      notify();
      return updated.recoveryKey;
    },

    keyFile: () => keyFile,

    dispose() {
      if (disposed) return;
      disposed = true;
      if (commitTimer !== null) clearTimeout(commitTimer);
      commitTimer = null;
      listeners.clear();
    },
  };
}
