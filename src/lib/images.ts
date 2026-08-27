import { slugify } from './paths';

/** Spec §8.3. Above either threshold the image is downscaled before upload. */
export const MAX_EDGE = 1600;
export const DOWNSCALE_ABOVE_BYTES = 1_000_000;
export const REJECT_ABOVE_BYTES = 5_000_000;
export const RE_ENCODE_QUALITY = 0.85;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime] ?? 'bin';
}

export function isSupportedImage(mime: string): boolean {
  return mime in EXTENSIONS;
}

/** First 8 hex characters of the SHA-256 of the content: enough to dedupe a vault. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

/** `assets/YYYY/MM/<slug>-<hash8>.<ext>`, vault-root-relative as §8.3 requires. */
export function assetPath(fileName: string, hash: string, mime: string, at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  // Lower-cased: asset names are generated, never typed, and a vault that is
  // cloned onto a case-insensitive filesystem should not be able to collide
  // "Photo-ab12.png" with "photo-ab12.png".
  const stem = slugify(fileName.replace(/\.[^.]+$/, ''))
    .toLowerCase()
    .slice(0, 40);
  return `assets/${year}/${month}/${stem}-${hash}.${extensionFor(mime)}`;
}

export function shouldDownscale(width: number, height: number, byteLength: number): boolean {
  return Math.max(width, height) > MAX_EDGE || byteLength > DOWNSCALE_ABOVE_BYTES;
}

/** Target dimensions that fit MAX_EDGE while keeping the aspect ratio. */
export function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height };
  const ratio = MAX_EDGE / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export interface RawImage {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  name: string;
}

export interface PreparedImage {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  /** The markdown to insert at the cursor. */
  markdown: string;
}

/** Injected so the pipeline is testable without a canvas, and so a headless
 * environment degrades to "upload as-is" rather than throwing. */
export type Downscaler = (image: RawImage) => Promise<RawImage>;

export interface PrepareDeps {
  /** Paths already in the vault, for content-hash de-duplication. */
  existing?: Iterable<string>;
  downscale?: Downscaler;
  now?: () => Date;
}

/**
 * Downscale (if needed), hash, name, and produce the markdown for an image.
 * Identical content lands on the same path, which is the de-duplication
 * §8.3 asks for: the second paste of the same picture reuses the first upload.
 */
export async function prepareImage(input: RawImage, deps: PrepareDeps = {}): Promise<PreparedImage> {
  if (!isSupportedImage(input.mime)) {
    throw new ImageError(`${input.mime || 'That file'} is not an image Topazius can store.`);
  }

  const downscale = deps.downscale ?? passthrough;
  const shrunk = input.bytes.length > DOWNSCALE_ABOVE_BYTES ? await downscale(input) : input;

  if (shrunk.bytes.length > REJECT_ABOVE_BYTES) {
    const mb = (shrunk.bytes.length / 1_000_000).toFixed(1);
    throw new ImageError(
      `That image is ${mb}MB after compression, above the ${REJECT_ABOVE_BYTES / 1_000_000}MB limit. Resize it before adding it.`,
    );
  }

  const hash = await hashBytes(shrunk.bytes);
  const fresh = assetPath(input.name, hash, shrunk.mime, deps.now?.() ?? new Date());
  // A path already holding this exact content is the same image; reuse it
  // rather than committing a second copy under today's date.
  const duplicate = [...(deps.existing ?? [])].find((path) => path.includes(`-${hash}.`));
  const path = duplicate ?? fresh;

  return {
    path,
    bytes: shrunk.bytes,
    mime: shrunk.mime,
    markdown: `![${input.name.replace(/[[\]]/g, '')}](${path})`,
  };
}

const passthrough: Downscaler = (image) => Promise.resolve(image);

/**
 * Canvas downscale, used in the browser. Re-encodes to JPEG unless the source
 * has transparency worth keeping, in which case PNG is kept.
 */
export const canvasDownscaler: Downscaler = async (image) => {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return image;

  const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mime });
  const bitmap = await createImageBitmap(blob);
  const size = scaledSize(bitmap.width, bitmap.height);

  if (size.width === bitmap.width && size.height === bitmap.height && image.bytes.length <= DOWNSCALE_ABOVE_BYTES) {
    bitmap.close();
    return image;
  }

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return image;
  }
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();

  const keepsAlpha = image.mime === 'image/png' || image.mime === 'image/webp';
  const outputMime = keepsAlpha ? image.mime : 'image/jpeg';
  const encoded = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputMime, RE_ENCODE_QUALITY),
  );
  if (!encoded) return image;

  const bytes = new Uint8Array(await encoded.arrayBuffer());
  // Re-encoding a small PNG can make it larger; keep whichever is smaller.
  return bytes.length < image.bytes.length ? { bytes, mime: outputMime, name: image.name } : image;
};

/**
 * Resolve a relative image source the way §8.3 specifies: vault-root-relative
 * first, then relative to the note's own folder. Returns null when neither
 * exists, so the renderer can name what is missing instead of failing silently.
 */
export function resolveAssetPath(notePath: string, src: string, known: Set<string>): string | null {
  const cleaned = src.replace(/^\.\//, '').replace(/^\/+/, '').split(/[?#]/)[0] ?? '';
  if (cleaned === '') return null;
  if (known.has(cleaned)) return cleaned;

  const folder = notePath.split('/').slice(0, -1).join('/');
  const relative = folder ? `${folder}/${cleaned}` : cleaned;
  return known.has(relative) ? relative : null;
}

/**
 * Object URLs for decrypted image bytes, one per vault path.
 *
 * They must be revoked - each one pins its blob in memory for the lifetime of
 * the document otherwise - so the owner (the preview pane) calls releaseAll()
 * on note switch and unmount, and logout revokes through the same door.
 */
export interface ObjectUrlCache {
  get(path: string): string | undefined;
  set(path: string, bytes: Uint8Array, mime: string): string;
  release(path: string): void;
  releaseAll(): void;
  size(): number;
}

export function createObjectUrlCache(): ObjectUrlCache {
  const urls = new Map<string, string>();
  return {
    get: (path) => urls.get(path),
    set(path, bytes, mime) {
      const existing = urls.get(path);
      if (existing) URL.revokeObjectURL(existing);
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
      urls.set(path, url);
      return url;
    },
    release(path) {
      const url = urls.get(path);
      if (!url) return;
      URL.revokeObjectURL(url);
      urls.delete(path);
    },
    releaseAll() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
    size: () => urls.size,
  };
}

/** The mime type an asset cache entry should carry, inferred from its extension. */
export function mimeForPath(path: string): string {
  const extension = path.replace(/\.enc$/, '').split('.').at(-1)?.toLowerCase() ?? '';
  const found = Object.entries(EXTENSIONS).find(([, value]) => value === extension);
  return found?.[0] ?? 'application/octet-stream';
}
