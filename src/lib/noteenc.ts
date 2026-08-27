import { IV_BYTES, randomBytes } from './crypto';
import { isEncryptedPath, noteStem } from './paths';

/** The magic that opens the payload line, and the first half of the AAD. */
export const MAGIC = 'TPZ1';

/**
 * A sealed note is UTF-8 text, not a binary blob, so GitHub's web UI renders it
 * as a file and anyone who finds one learns what it is and what opens it
 * (spec §9.4).
 */
const HEADER = [
  '# topazius-encrypted v1',
  '# https://github.com/topazius/topazius — needs your passphrase or recovery key',
];

export class NoteEncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteEncError';
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * AAD binds the ciphertext to its path: an attacker with write access cannot
 * relocate journal/private.md.enc into inbox/note.md.enc and have it decrypt
 * (spec §9.4). The consequence is that renaming a sealed note re-seals it.
 */
function aad(path: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(MAGIC + path);
}

/** True for text that looks like a sealed note, whatever its filename says. */
export function isSealed(text: string): boolean {
  return /^TPZ1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/m.test(text);
}

/**
 * Seal arbitrary bytes into the §9.4 file body.
 *
 * Images use this too (§8.3): one envelope, one code path, one thing to get
 * right. The base64 costs a third more bytes than a binary container would,
 * which is the same overhead the Contents API charges on the way to GitHub
 * anyway.
 */
export async function seal(vmk: CryptoKey, path: string, bytes: Uint8Array): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(path) },
    vmk,
    bytes as Uint8Array<ArrayBuffer>,
  );
  const payload = `${MAGIC}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
  return `${HEADER.join('\n')}\n${payload}\n`;
}

/** Seal a note's exact bytes, frontmatter included. */
export function sealNote(vmk: CryptoKey, path: string, text: string): Promise<string> {
  return seal(vmk, path, new TextEncoder().encode(text));
}

/** Reverse seal(). Throws NoteEncError on a wrong key, wrong path, or tampering. */
export async function open(vmk: CryptoKey, path: string, fileText: string): Promise<Uint8Array> {
  const line = fileText.split(/\r?\n/).find((candidate) => candidate.startsWith(`${MAGIC}.`));
  if (!line) {
    throw new NoteEncError('This file is not a sealed Topazius note.');
  }
  const [, ivPart, ctPart] = line.split('.');
  if (!ivPart || !ctPart) {
    throw new NoteEncError('This sealed note is malformed.');
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(ivPart), additionalData: aad(path) },
      vmk,
      fromBase64Url(ctPart),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new NoteEncError(
      'This note could not be decrypted. It may have been moved, edited by hand, or sealed with a different key.',
    );
  }
}

export async function openNote(vmk: CryptoKey, path: string, fileText: string): Promise<string> {
  return new TextDecoder().decode(await open(vmk, path, fileText));
}

/** `a.md` ⇄ `a.md.enc`: the two states of one note, per spec §9.5. */
export function toggledPath(path: string): string {
  return isEncryptedPath(path) ? `${noteStem(path)}.md` : `${path}.enc`;
}

/**
 * Per-folder creation defaults (spec §9.5). Advisory and creation-time only:
 * they never encrypt or decrypt an existing note. Most specific prefix wins.
 */
export type EncryptionDefault = 'plain' | 'encrypted';

export function defaultForFolder(
  defaults: Record<string, EncryptionDefault> | undefined,
  folder: string,
): EncryptionDefault {
  if (!defaults) return 'plain';
  const probe = folder === '' ? '' : `${folder.replace(/\/+$/, '')}/`;
  let best = '';
  let winner: EncryptionDefault = 'plain';
  for (const [prefix, value] of Object.entries(defaults)) {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (probe.startsWith(normalized) && normalized.length >= best.length) {
      best = normalized;
      winner = value;
    }
  }
  return winner;
}

/** The path a new note should get, given the folder defaults. */
export function newNotePath(
  folder: string,
  fileStem: string,
  defaults?: Record<string, EncryptionDefault>,
): string {
  const base = folder ? `${folder.replace(/\/+$/, '')}/${fileStem}` : fileStem;
  return defaultForFolder(defaults, folder) === 'encrypted' ? `${base}.md.enc` : `${base}.md`;
}
