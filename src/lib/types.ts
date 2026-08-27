/** AES-GCM ciphertext with the IV it was sealed under. */
export interface EncryptedBlob {
  iv: Uint8Array<ArrayBuffer>;
  ct: Uint8Array<ArrayBuffer>;
}

/** An EncryptedBlob plus the KDF salt needed to re-derive its key. */
export interface WrappedSecret extends EncryptedBlob {
  salt: Uint8Array<ArrayBuffer>;
  v: number;
}

/** Which repository this vault points at. Not secret. */
export interface VaultConfig {
  owner: string;
  repo: string;
  branch: string;
}

/** A cached note. `enc` holds the note's exact UTF-8 bytes, encrypted. */
export interface NoteRecord {
  path: string;
  sha: string;
  size: number;
  enc: EncryptedBlob;
  mtime: number;
  dirty: boolean;
}

/** A cached image. `enc` holds the raw file bytes, encrypted. */
export interface AssetRecord {
  path: string;
  sha: string;
  mime: string;
  enc: EncryptedBlob;
}
