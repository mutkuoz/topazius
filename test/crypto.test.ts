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
