import { IV_BYTES, PBKDF2_ITERATIONS, SALT_BYTES, randomBytes } from './crypto';

/** Where the wrapped vault key lives in the notes repo (spec §4.1). */
export const VAULT_KEY_PATH = '.topazius/vault.json';

export const VAULT_KEY_VERSION = 1;

/** Crockford base32: no I, L, O or U, so a hand-copied key cannot be misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_BITS = 128;
const RECOVERY_CHARS = Math.ceil(RECOVERY_BITS / 5); // 26
const GROUP = 4;

export type WrapId = 'passphrase' | 'recovery';

/** One slot of `.topazius/vault.json`: the VMK sealed under one key-encryption key. */
export interface Wrap {
  id: WrapId;
  salt: string;
  iv: string;
  ct: string;
}

export interface VaultKeyFile {
  v: number;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number };
  cipher: 'AES-256-GCM';
  wraps: Wrap[];
}

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyError';
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A 128-bit recovery key, rendered as 26 Crockford base32 characters in groups
 * of four (spec §9.3). Shown exactly once, at the ceremony that precedes the
 * first encryption.
 */
export function generateRecoveryKey(): string {
  const bytes = randomBytes(Math.ceil((RECOVERY_CHARS * 5) / 8));
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < RECOVERY_CHARS) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  return format(out);
}

export function format(key: string): string {
  return (key.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? []).join('-');
}

/**
 * Canonicalise a typed-in recovery key: case, grouping, and the three
 * substitutions Crockford defines (I and L read as 1, O as 0) are all forgiven,
 * because the user is copying it off paper.
 */
export function normalizeRecoveryKey(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

  if (cleaned.length !== RECOVERY_CHARS) {
    throw new VaultKeyError(`A recovery key is ${RECOVERY_CHARS} characters long.`);
  }
  for (const char of cleaned) {
    if (!ALPHABET.includes(char)) {
      throw new VaultKeyError('That is not a valid recovery key.');
    }
  }
  return cleaned;
}

async function deriveKek(secret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
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

/**
 * Import raw VMK bytes as a usable key.
 *
 * Deliberately extractable: §9.2's "changing the passphrase rewraps one file"
 * and §9.3's "the recovery key can be regenerated" both require re-wrapping the
 * *same* VMK under a new KEK, and WebCrypto cannot wrap a non-extractable key.
 * The VMK still only ever exists in session memory - never in IndexedDB, never
 * in a component, never unwrapped in the repository.
 */
function importVmk(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

async function wrapUnder(secret: string, id: WrapId, raw: Uint8Array<ArrayBuffer>): Promise<Wrap> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kek = await deriveKek(secret, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
  return { id, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

export interface NewVaultKey {
  file: VaultKeyFile;
  vmk: CryptoKey;
  recoveryKey: string;
}

/**
 * Generate the Vault Master Key and wrap it under both the passphrase and a
 * fresh recovery key. Called once, the first time a note is encrypted.
 */
export async function createVaultKey(passphrase: string, recoveryKey?: string): Promise<NewVaultKey> {
  const key = recoveryKey ?? generateRecoveryKey();
  const raw = randomBytes(32);
  const file: VaultKeyFile = {
    v: VAULT_KEY_VERSION,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS },
    cipher: 'AES-256-GCM',
    wraps: [
      await wrapUnder(passphrase, 'passphrase', raw),
      await wrapUnder(normalizeRecoveryKey(key), 'recovery', raw),
    ],
  };
  const vmk = await importVmk(raw);
  raw.fill(0);
  return { file, vmk, recoveryKey: key };
}

/**
 * Unwrap the VMK with a passphrase or a recovery key. AES-GCM's tag is the
 * verifier, so a wrong secret - or a substituted vault.json - fails closed
 * rather than yielding attacker-chosen key material (spec §9.2).
 */
export async function unwrapVaultKey(
  file: VaultKeyFile,
  secret: string,
  which: WrapId,
): Promise<CryptoKey> {
  if (file.v !== VAULT_KEY_VERSION) {
    throw new VaultKeyError(`This vault key file is version ${file.v}, which this app cannot read.`);
  }
  const normalized = which === 'recovery' ? normalizeRecoveryKey(secret) : secret;
  const wrap = file.wraps.find((candidate) => candidate.id === which);
  if (!wrap) {
    throw new VaultKeyError(`This vault has no ${which} key. Use the other one.`);
  }

  const kek = await deriveKek(normalized, fromBase64(wrap.salt));
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(wrap.iv) },
      kek,
      fromBase64(wrap.ct),
    );
  } catch {
    throw new VaultKeyError(
      which === 'recovery'
        ? 'That recovery key does not open this vault.'
        : 'That passphrase does not open this vault.',
    );
  }

  const bytes = new Uint8Array(raw);
  const vmk = await importVmk(bytes);
  bytes.fill(0);
  return vmk;
}

/** Replace one slot, leaving the other - and every note ciphertext - untouched. */
export async function rewrap(
  file: VaultKeyFile,
  vmk: CryptoKey,
  which: WrapId,
  secret: string,
): Promise<VaultKeyFile> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', vmk));
  const normalized = which === 'recovery' ? normalizeRecoveryKey(secret) : secret;
  const replacement = await wrapUnder(normalized, which, raw);
  raw.fill(0);
  return {
    ...file,
    wraps: [...file.wraps.filter((wrap) => wrap.id !== which), replacement].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
}

export function serializeVaultKeyFile(file: VaultKeyFile): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
}

export function parseVaultKeyFile(bytes: Uint8Array): VaultKeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new VaultKeyError(`${VAULT_KEY_PATH} is not readable JSON.`);
  }
  const file = parsed as VaultKeyFile;
  if (!file || typeof file.v !== 'number' || !Array.isArray(file.wraps)) {
    throw new VaultKeyError(`${VAULT_KEY_PATH} is not a Topazius vault key file.`);
  }
  return file;
}
