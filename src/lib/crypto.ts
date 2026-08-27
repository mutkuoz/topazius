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
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function params(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  const p: AesGcmParams = { name: 'AES-GCM', iv: new Uint8Array(iv) };
  if (aad) p.additionalData = new Uint8Array(aad);
  return p;
}

export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<EncryptedBlob> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(params(iv, aad), key, new Uint8Array(plaintext));
  return { iv, ct: new Uint8Array(ct) };
}

/** Throws on a wrong key, a wrong AAD, or tampered ciphertext. Never returns garbage. */
export async function decrypt(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(params(blob.iv, aad), key, new Uint8Array(blob.ct));
  return new Uint8Array(pt);
}
