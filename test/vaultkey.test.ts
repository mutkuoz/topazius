import { describe, expect, it } from 'vitest';
import { PBKDF2_ITERATIONS } from '../src/lib/crypto';
import {
  VAULT_KEY_PATH,
  VaultKeyError,
  createVaultKey,
  format,
  generateRecoveryKey,
  normalizeRecoveryKey,
  parseVaultKeyFile,
  rewrap,
  serializeVaultKeyFile,
  unwrapVaultKey,
} from '../src/lib/vaultkey';

const PASSPHRASE = 'correct horse battery staple';

async function rawOf(key: CryptoKey): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.exportKey('raw', key))].join(',');
}

describe('recovery keys', () => {
  it('are 26 Crockford characters in groups of four', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{1,4}){6}$/);
    expect(key.replace(/-/g, '')).toHaveLength(26);
  });

  it('are different every time', () => {
    expect(generateRecoveryKey()).not.toBe(generateRecoveryKey());
  });

  it('forgive case, grouping, and the letters Crockford drops', () => {
    const canonical = normalizeRecoveryKey(generateRecoveryKey());
    expect(normalizeRecoveryKey(format(canonical).toLowerCase())).toBe(canonical);
    // I and L stand in for 1, O for 0 - the misreadings a paper copy invites.
    expect(normalizeRecoveryKey('IL0'.padEnd(26, '2'))).toBe('110'.padEnd(26, '2'));
    expect(normalizeRecoveryKey('O'.padEnd(26, '2'))).toBe('0'.padEnd(26, '2'));
  });

  it('reject a key of the wrong length or with characters outside the alphabet', () => {
    expect(() => normalizeRecoveryKey('ABC')).toThrow(VaultKeyError);
    expect(() => normalizeRecoveryKey('U'.repeat(26))).toThrow(VaultKeyError);
  });
});

describe('createVaultKey', () => {
  it('writes both wraps and records the KDF it used', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    expect(file.wraps.map((wrap) => wrap.id).sort()).toEqual(['passphrase', 'recovery']);
    expect(file.kdf).toEqual({ name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS });
    expect(file.cipher).toBe('AES-256-GCM');
  });

  it('never writes the vault key itself into the file', async () => {
    const { file, vmk } = await createVaultKey(PASSPHRASE);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', vmk));
    const json = JSON.stringify(file);
    let binary = '';
    for (const byte of raw) binary += String.fromCharCode(byte);
    expect(json).not.toContain(btoa(binary));
  });

  it('gives each wrap its own salt and IV', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    const [a, b] = file.wraps;
    expect(a?.salt).not.toBe(b?.salt);
    expect(a?.iv).not.toBe(b?.iv);
  });
});

describe('unwrapVaultKey', () => {
  it('recovers the same key from either slot', async () => {
    const { file, vmk, recoveryKey } = await createVaultKey(PASSPHRASE);
    const expected = await rawOf(vmk);

    expect(await rawOf(await unwrapVaultKey(file, PASSPHRASE, 'passphrase'))).toBe(expected);
    expect(await rawOf(await unwrapVaultKey(file, recoveryKey, 'recovery'))).toBe(expected);
  });

  it('fails closed on a wrong passphrase', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    await expect(unwrapVaultKey(file, 'not the passphrase', 'passphrase')).rejects.toThrow(
      /passphrase does not open/,
    );
  });

  it('fails closed on a wrong recovery key', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    await expect(unwrapVaultKey(file, generateRecoveryKey(), 'recovery')).rejects.toThrow(
      /recovery key does not open/,
    );
  });

  it('fails closed when a wrap is substituted by someone with repo write access', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    const attacker = await createVaultKey('attacker chosen passphrase');
    const tampered = {
      ...file,
      wraps: file.wraps.map((wrap) =>
        wrap.id === 'passphrase' ? (attacker.file.wraps.find((w) => w.id === 'passphrase') ?? wrap) : wrap,
      ),
    };

    await expect(unwrapVaultKey(tampered, PASSPHRASE, 'passphrase')).rejects.toThrow(VaultKeyError);
  });

  it('refuses a file version it does not understand', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    await expect(unwrapVaultKey({ ...file, v: 99 }, PASSPHRASE, 'passphrase')).rejects.toThrow(/version 99/);
  });
});

describe('rewrap', () => {
  it('changes the passphrase without touching the recovery slot or the key', async () => {
    const { file, vmk, recoveryKey } = await createVaultKey(PASSPHRASE);
    const expected = await rawOf(vmk);

    const rewrapped = await rewrap(file, vmk, 'passphrase', 'a completely different passphrase');

    expect(await rawOf(await unwrapVaultKey(rewrapped, 'a completely different passphrase', 'passphrase'))).toBe(
      expected,
    );
    expect(await rawOf(await unwrapVaultKey(rewrapped, recoveryKey, 'recovery'))).toBe(expected);
    await expect(unwrapVaultKey(rewrapped, PASSPHRASE, 'passphrase')).rejects.toThrow(VaultKeyError);
  });

  it('regenerating the recovery key invalidates the previous one', async () => {
    const { file, vmk, recoveryKey } = await createVaultKey(PASSPHRASE);
    const replacement = generateRecoveryKey();

    const rewrapped = await rewrap(file, vmk, 'recovery', replacement);

    expect(await rawOf(await unwrapVaultKey(rewrapped, replacement, 'recovery'))).toBe(await rawOf(vmk));
    await expect(unwrapVaultKey(rewrapped, recoveryKey, 'recovery')).rejects.toThrow(VaultKeyError);
  });

  it('keeps exactly one wrap per slot', async () => {
    const { file, vmk } = await createVaultKey(PASSPHRASE);
    const rewrapped = await rewrap(file, vmk, 'passphrase', 'another passphrase entirely');
    expect(rewrapped.wraps).toHaveLength(2);
  });
});

describe('serialization', () => {
  it('round-trips through the bytes that go in the repository', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    expect(parseVaultKeyFile(serializeVaultKeyFile(file))).toEqual(file);
  });

  it('is human-inspectable JSON ending in a newline', async () => {
    const { file } = await createVaultKey(PASSPHRASE);
    const text = new TextDecoder().decode(serializeVaultKeyFile(file));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('"kdf"');
  });

  it('rejects a file that is not a vault key file', () => {
    expect(() => parseVaultKeyFile(new TextEncoder().encode('not json'))).toThrow(VAULT_KEY_PATH);
    expect(() => parseVaultKeyFile(new TextEncoder().encode('{"hello":1}'))).toThrow(VaultKeyError);
  });
});
