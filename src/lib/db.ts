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
