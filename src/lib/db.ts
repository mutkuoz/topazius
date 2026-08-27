import { type DBSchema, type IDBPDatabase, deleteDB, openDB } from 'idb';
import type { AssetRecord, NoteRecord, VaultConfig, WrappedSecret } from './types';
import type { VaultKeyFile } from './vaultkey';

export const DB_NAME = 'topazius';
/** v2 added the `vaultkey` store; v1 vaults upgrade in place, keeping their notes. */
export const DB_VERSION = 2;

export type AppConfig = VaultConfig & { prefs: Record<string, unknown> };

/** One pending remote write. Content is never stored here - see queue.ts's `resolve`. */
export interface QueueItem {
  id?: number;
  op: 'put' | 'delete';
  path: string;
  /**
   * For a delete, the blob sha the removal is based on. Remembered on the item
   * because the local note record - where the sha otherwise lives - is gone by
   * the time this runs.
   */
  sha?: string;
  attempts: number;
  lastError?: string;
  /** Wall-clock time before which this item must not be retried (backoff). */
  notBefore?: number;
}

export interface TopaziusDB extends DBSchema {
  /** Deliberately plaintext: the lock screen must be able to name the repo. */
  config: { key: string; value: AppConfig };
  secret: { key: string; value: WrappedSecret };
  notes: { key: string; value: NoteRecord };
  assets: { key: string; value: AssetRecord };
  queue: { key: number; value: QueueItem };
  /**
   * A copy of the repository's `.topazius/vault.json`. Wrapped key material
   * only - useless without the passphrase or the recovery key - kept locally so
   * unlock can open encrypted notes without a second prompt and without
   * holding the passphrase in memory past unlock.
   */
  vaultkey: { key: string; value: VaultKeyFile };
}

export function openVaultDB(): Promise<IDBPDatabase<TopaziusDB>> {
  const dbPromise = openDB<TopaziusDB>(DB_NAME, DB_VERSION, {
    // Each store is created only if it is missing, so a v1 vault gains the
    // v2 store without losing the notes already cached in it.
    upgrade(db) {
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config');
      if (!db.objectStoreNames.contains('secret')) db.createObjectStore('secret');
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('vaultkey')) db.createObjectStore('vaultkey');
    },
    // Fires on THIS connection when another tab tries to open a newer
    // version or delete the database (see destroyVaultDB) while this one is
    // still open. Without closing here, that other tab's operation blocks
    // forever with no feedback - "I forgot my passphrase" would hang.
    // Closing lets it proceed; this tab notices on its next call and
    // re-opens.
    blocking() {
      void dbPromise.then((db) => db.close());
    },
  });
  return dbPromise;
}

/**
 * Logout path: removes the encrypted token and every cached note.
 * deleteDatabase() blocks until every open connection closes; if another
 * tab's connection does not close in time, `onBlocked` lets the caller
 * surface "close other tabs of this app" instead of hanging with no
 * feedback. openVaultDB()'s own `blocking` handler closes same-app tabs
 * automatically, so this is the fallback for whatever does not.
 */
export async function destroyVaultDB(onBlocked?: () => void): Promise<void> {
  await deleteDB(DB_NAME, {
    blocked() {
      onBlocked?.();
    },
  });
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

export function readAsset(db: IDBPDatabase<TopaziusDB>, path: string): Promise<AssetRecord | undefined> {
  return db.get('assets', path);
}

export async function writeAsset(db: IDBPDatabase<TopaziusDB>, asset: AssetRecord): Promise<void> {
  await db.put('assets', asset);
}

export function allAssets(db: IDBPDatabase<TopaziusDB>): Promise<AssetRecord[]> {
  return db.getAll('assets');
}

export async function deleteAsset(db: IDBPDatabase<TopaziusDB>, path: string): Promise<void> {
  await db.delete('assets', path);
}

export function readVaultKeyFile(db: IDBPDatabase<TopaziusDB>): Promise<VaultKeyFile | undefined> {
  return db.get('vaultkey', 'vault');
}

export async function writeVaultKeyFile(db: IDBPDatabase<TopaziusDB>, file: VaultKeyFile): Promise<void> {
  await db.put('vaultkey', file, 'vault');
}
