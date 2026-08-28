import type { IDBPDatabase } from 'idb';
import { SALT_BYTES, decrypt, deriveKey, encrypt, randomBytes } from './crypto';
import {
  type TopaziusDB,
  destroyVaultDB,
  readSecret,
  readVaultKeyFile,
  writeSecret,
  writeVaultKeyFile,
} from './db';
import {
  type VaultKeyFile,
  createVaultKey,
  generateRecoveryKey,
  rewrap,
  unwrapVaultKey,
} from './vaultkey';

export const MIN_PASSPHRASE_LENGTH = 10;
export const SECRET_VERSION = 1;

export type SessionState = 'loading' | 'empty' | 'locked' | 'unlocked';

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
  /**
   * The Vault Master Key, or null when this vault has no encrypted notes yet -
   * or has them but has not been given the passphrase for the key file since
   * this device last saw it. Lives here, next to the session key, and is never
   * written to storage unwrapped (spec §6).
   */
  getVaultKey(): CryptoKey | null;
  /**
   * Create the vault key on first encryption: a fresh VMK wrapped under the
   * passphrase and a new recovery key. Returns the file to commit and the
   * recovery key to show exactly once (spec §9.3).
   */
  createVaultKey(passphrase: string): Promise<{ file: VaultKeyFile; recoveryKey: string }>;
  /** Open an existing key file with the passphrase, or with the recovery key. */
  openVaultKey(file: VaultKeyFile, secret: string, which: 'passphrase' | 'recovery'): Promise<void>;
  /**
   * True when this is the passphrase the enrolled token is sealed under.
   *
   * The encryption ceremony asks for the passphrase again and wraps the vault
   * key under whatever is typed. Without this check a typo would produce a
   * vault key that the passphrase cannot open - discovered on the next unlock,
   * long after the recovery key has been put away.
   */
  verifyPassphrase(passphrase: string): Promise<boolean>;
  /** Issue a new recovery key, invalidating the previous one (spec §9.3). */
  regenerateRecoveryKey(file: VaultKeyFile): Promise<{ file: VaultKeyFile; recoveryKey: string }>;
  touch(): void;
  onChange(listener: () => void): () => void;
  /**
   * Terminal for this `Session` and for the `IDBPDatabase` it was constructed
   * with: it closes the injected `deps.db` connection and deletes the
   * database. Neither this `Session` nor that `db` handle can be used
   * afterwards — every subsequent call other than `state()`/`onChange()`
   * operates against a closed connection and will throw. A caller that wants
   * to continue (e.g. enrolling a new token in the same page load) must
   * `openVaultDB()` again and `createSession()` a fresh instance with it.
   */
  logout(): Promise<void>;
}

export function createSession(deps: SessionDeps): Session {
  const idleMs = (deps.idleMinutes ?? 15) * 60_000;

  // The only place the keys and the token live. Never stored, never handed to
  // the UI - components receive bound closures, not key material.
  let key: CryptoKey | null = null;
  let token: string | null = null;
  let vmk: CryptoKey | null = null;
  let hasSecret: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Wall-clock deadline mirroring `timer`. A `setTimeout` fired late (a
  // throttled background tab, a laptop that slept) or one armed before a
  // caller's fake clock existed cannot be trusted alone, so every accessor
  // re-checks elapsed time against this deadline before answering.
  let deadline: number | null = null;
  // Bumped by lock() and logout(). enroll()/unlock() capture it before their
  // real async work (PBKDF2, decrypt, storage) and refuse to assign key/token
  // afterwards if it moved — otherwise an in-flight unlock() can resurrect a
  // token after the user (or the idle timer) locked or logged out mid-await.
  let epoch = 0;
  const listeners = new Set<() => void>();

  // A throwing listener must not stop the others, nor escape onto the
  // render path: notify() is reachable from state()/getToken()/getKey() via
  // checkIdle() -> lock(), all of which app.tsx calls in the render body.
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('session listener threw', error);
      }
    }
  };

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    deadline = null;
  }

  function armTimer() {
    clearTimer();
    if (idleMs > 0) {
      deadline = Date.now() + idleMs;
      timer = setTimeout(lock, idleMs);
    }
  }

  function lock() {
    epoch++;
    clearTimer();
    if (key === null && token === null && vmk === null) return;
    key = null;
    token = null;
    vmk = null;
    notify();
  }

  function checkIdle() {
    if (key !== null && deadline !== null && Date.now() >= deadline) lock();
  }

  async function derive(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
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
      checkIdle();
      if (key !== null) return 'unlocked';
      if (hasSecret === null) return 'loading';
      return hasSecret === false ? 'empty' : 'locked';
    },

    async enroll(newToken, passphrase) {
      const mine = epoch;
      const salt = randomBytes(SALT_BYTES);
      const derived = await derive(passphrase, salt);
      const blob = await encrypt(derived, new TextEncoder().encode(newToken));

      await writeSecret(deps.db, { v: SECRET_VERSION, salt, iv: blob.iv, ct: blob.ct });

      // A lock() or logout() ran while this was in flight — do not resurrect it.
      if (mine !== epoch) return;

      key = derived;
      token = newToken;
      hasSecret = true;
      armTimer();
      notify();
    },

    async unlock(passphrase) {
      const mine = epoch;
      const stored = await readSecret(deps.db);
      if (!stored) throw new Error('No token is enrolled on this device.');

      const derived = await derive(passphrase, stored.salt);
      // AES-GCM's auth tag is the verifier: a wrong passphrase throws here.
      const plaintext = await decrypt(derived, { iv: stored.iv, ct: stored.ct });

      // A lock() or logout() ran while this was in flight — do not resurrect it.
      if (mine !== epoch) {
        plaintext.fill(0);
        return;
      }

      key = derived;
      token = new TextDecoder().decode(plaintext);
      // The string above is the copy that matters; zero the bytes it was
      // decoded from so the decrypted token doesn't linger in this
      // Uint8Array any longer than it has to.
      plaintext.fill(0);
      hasSecret = true;

      // Open the vault key here, while the passphrase is in hand, so it is
      // never held past this call. A cached key file that this passphrase
      // does not open (it was rewrapped on another device) is not an error:
      // vmk stays null and the UI asks for a secret when a sealed note is
      // actually opened.
      const cached = await readVaultKeyFile(deps.db);
      if (cached && mine === epoch) {
        try {
          vmk = await unwrapVaultKey(cached, passphrase, 'passphrase');
        } catch {
          vmk = null;
        }
      }

      armTimer();
      notify();
    },

    lock,

    getToken() {
      checkIdle();
      if (token === null) throw new Error('Vault is locked.');
      return token;
    },

    getKey() {
      checkIdle();
      if (key === null) throw new Error('Vault is locked.');
      return key;
    },

    getVaultKey() {
      checkIdle();
      return vmk;
    },

    async createVaultKey(passphrase) {
      const mine = epoch;
      const created = await createVaultKey(passphrase);
      await writeVaultKeyFile(deps.db, created.file);
      if (mine !== epoch) return { file: created.file, recoveryKey: created.recoveryKey };
      vmk = created.vmk;
      notify();
      return { file: created.file, recoveryKey: created.recoveryKey };
    },

    async verifyPassphrase(passphrase) {
      const stored = await readSecret(deps.db);
      if (!stored) return false;
      try {
        const derived = await derive(passphrase, stored.salt);
        // AES-GCM's tag is the verifier; a wrong passphrase throws here.
        (await decrypt(derived, { iv: stored.iv, ct: stored.ct })).fill(0);
        return true;
      } catch {
        return false;
      }
    },

    async openVaultKey(file, secret, which) {
      const mine = epoch;
      const opened = await unwrapVaultKey(file, secret, which);
      await writeVaultKeyFile(deps.db, file);
      if (mine !== epoch) return;
      vmk = opened;
      notify();
    },

    async regenerateRecoveryKey(file) {
      if (vmk === null) throw new Error('Unlock the vault key before issuing a new recovery key.');
      const recoveryKey = generateRecoveryKey();
      const updated = await rewrap(file, vmk, 'recovery', recoveryKey);
      await writeVaultKeyFile(deps.db, updated);
      return { file: updated, recoveryKey };
    },

    touch() {
      checkIdle();
      if (key !== null) armTimer();
    },

    onChange(listener) {
      listeners.add(listener);
      // Replay immediately so a subscriber that attaches after the
      // constructor-time readSecret() probe already resolved (or after any
      // other notify()) still learns the current state, instead of relying
      // on the caller to subscribe in the same synchronous tick as
      // construction.
      try {
        listener();
      } catch (error) {
        console.error('session listener threw', error);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    // Terminal: closes deps.db and destroys the vault database. This Session
    // and the db handle it was built with are both dead once this resolves —
    // see the doc comment on Session.logout().
    async logout() {
      epoch++;
      clearTimer();
      key = null;
      token = null;
      vmk = null;
      hasSecret = false;
      // IndexedDB's deleteDatabase() blocks until every open connection to it
      // closes; without this the still-open deps.db connection would leave
      // the delete pending forever.
      deps.db.close();
      await destroyVaultDB();
      notify();
    },
  };
}
