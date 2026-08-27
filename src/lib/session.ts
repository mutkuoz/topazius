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

  // The only place the key and token live. Never stored, never handed to the UI.
  let key: CryptoKey | null = null;
  let token: string | null = null;
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

  const notify = () => listeners.forEach((listener) => listener());

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
    if (key === null && token === null) return;
    key = null;
    token = null;
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
      if (mine !== epoch) return;

      key = derived;
      token = new TextDecoder().decode(plaintext);
      hasSecret = true;
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

    touch() {
      checkIdle();
      if (key !== null) armTimer();
    },

    onChange(listener) {
      listeners.add(listener);
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
