import { describe, expect, it } from 'vitest';
import {
  DOWNSCALE_ABOVE_BYTES,
  ImageError,
  MAX_EDGE,
  type RawImage,
  REJECT_ABOVE_BYTES,
  assetPath,
  extensionFor,
  hashBytes,
  mimeForPath,
  prepareImage,
  resolveAssetPath,
  scaledSize,
  shouldDownscale,
} from '../src/lib/images';

const raw = (bytes: Uint8Array, name = 'My Photo.png', mime = 'image/png'): RawImage => ({
  bytes: bytes as Uint8Array<ArrayBuffer>,
  name,
  mime,
});

const AUGUST = () => new Date(2026, 7, 27);

describe('naming', () => {
  it('builds a vault-root-relative path with the date, slug, and hash', async () => {
    const hash = await hashBytes(new Uint8Array([1, 2, 3]));
    expect(assetPath('My Photo.png', hash, 'image/png', AUGUST())).toBe(
      `assets/2026/08/my-photo-${hash}.png`,
    );
  });

  it('slugifies away characters a filesystem would refuse', () => {
    expect(assetPath('a/b:c?"<>|.jpeg', 'abcd1234', 'image/jpeg', AUGUST())).toBe(
      'assets/2026/08/abc-abcd1234.jpg',
    );
  });

  it('falls back to slugify\'s own placeholder when the name is all punctuation', () => {
    expect(assetPath('   .png', 'abcd1234', 'image/png', AUGUST())).toBe(
      'assets/2026/08/untitled-abcd1234.png',
    );
  });

  it('maps mime types to the extension people expect', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/webp')).toBe('webp');
    expect(mimeForPath('assets/2026/08/a-1234abcd.jpg')).toBe('image/jpeg');
    expect(mimeForPath('assets/2026/08/a-1234abcd.png.enc')).toBe('image/png');
  });
});

describe('hashing', () => {
  it('is stable and content-addressed', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(await hashBytes(bytes)).toBe(await hashBytes(new Uint8Array([1, 2, 3, 4])));
    expect(await hashBytes(bytes)).not.toBe(await hashBytes(new Uint8Array([1, 2, 3, 5])));
    expect(await hashBytes(bytes)).toHaveLength(8);
  });
});

describe('downscale thresholds', () => {
  it('triggers above the long-edge limit or the byte limit', () => {
    expect(shouldDownscale(MAX_EDGE + 1, 10, 100)).toBe(true);
    expect(shouldDownscale(10, MAX_EDGE + 1, 100)).toBe(true);
    expect(shouldDownscale(100, 100, DOWNSCALE_ABOVE_BYTES + 1)).toBe(true);
    expect(shouldDownscale(MAX_EDGE, MAX_EDGE, DOWNSCALE_ABOVE_BYTES)).toBe(false);
  });

  it('keeps the aspect ratio when scaling the long edge down', () => {
    expect(scaledSize(3200, 1600)).toEqual({ width: 1600, height: 800 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(scaledSize(4000, 3)).toEqual({ width: 1600, height: 1 });
  });
});

describe('prepareImage', () => {
  it('produces the path, bytes, and the markdown to insert', async () => {
    const prepared = await prepareImage(raw(new Uint8Array([1, 2, 3])), { now: AUGUST });
    expect(prepared.path).toMatch(/^assets\/2026\/08\/my-photo-[0-9a-f]{8}\.png$/);
    expect(prepared.markdown).toBe(`![My Photo.png](${prepared.path})`);
  });

  it('refuses a file that is not an image', async () => {
    await expect(prepareImage(raw(new Uint8Array([1]), 'a.pdf', 'application/pdf'))).rejects.toThrow(
      ImageError,
    );
  });

  it('downscales only when the file is over the byte threshold', async () => {
    let called = 0;
    const downscale = async (image: RawImage) => {
      called++;
      return { ...image, bytes: new Uint8Array([9]) as Uint8Array<ArrayBuffer> };
    };

    await prepareImage(raw(new Uint8Array(10)), { downscale });
    expect(called).toBe(0);

    await prepareImage(raw(new Uint8Array(DOWNSCALE_ABOVE_BYTES + 1)), { downscale });
    expect(called).toBe(1);
  });

  it('rejects an image still over the hard limit after compression', async () => {
    const downscale = async (image: RawImage) => image; // a compressor that cannot help
    await expect(
      prepareImage(raw(new Uint8Array(REJECT_ABOVE_BYTES + 1)), { downscale }),
    ).rejects.toThrow(/above the 5MB limit/);
  });

  it('reuses the existing asset when the same image is pasted twice', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const first = await prepareImage(raw(bytes), { now: AUGUST });

    const later = await prepareImage(raw(bytes, 'Screenshot.png'), {
      existing: [first.path],
      now: () => new Date(2027, 0, 2),
    });

    expect(later.path).toBe(first.path);
    expect(later.markdown).toBe(`![Screenshot.png](${first.path})`);
  });

  it('does not confuse a different image with the same name', async () => {
    const first = await prepareImage(raw(new Uint8Array([1])), { now: AUGUST });
    const second = await prepareImage(raw(new Uint8Array([2])), { existing: [first.path], now: AUGUST });
    expect(second.path).not.toBe(first.path);
  });
});

describe('resolveAssetPath', () => {
  const known = new Set(['assets/2026/08/pic-a1b2c3d4.png', 'work/diagrams/flow.png']);

  it('resolves a vault-root-relative source', () => {
    expect(resolveAssetPath('work/standup.md', 'assets/2026/08/pic-a1b2c3d4.png', known)).toBe(
      'assets/2026/08/pic-a1b2c3d4.png',
    );
  });

  it('falls back to a source relative to the note', () => {
    expect(resolveAssetPath('work/diagrams/notes.md', 'flow.png', known)).toBe('work/diagrams/flow.png');
  });

  it('tolerates ./ and a leading slash, and ignores a query or fragment', () => {
    expect(resolveAssetPath('a.md', './assets/2026/08/pic-a1b2c3d4.png?v=2', known)).toBe(
      'assets/2026/08/pic-a1b2c3d4.png',
    );
    expect(resolveAssetPath('a.md', '/assets/2026/08/pic-a1b2c3d4.png', known)).toBe(
      'assets/2026/08/pic-a1b2c3d4.png',
    );
  });

  it('returns null for something the vault does not have', () => {
    expect(resolveAssetPath('a.md', 'missing.png', known)).toBeNull();
    expect(resolveAssetPath('a.md', '', known)).toBeNull();
  });
});
