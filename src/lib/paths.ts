export const MAX_SEGMENT_BYTES = 200;
export const MAX_PATH_BYTES = 400;

const RESERVED_DIRS = ['assets/', '.topazius/'];

const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const ILLEGAL_IN_NAME = /[/\\:*?"<>|]/g;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/**
 * Normalise a vault-relative path and reject anything unsafe.
 * Returns the canonical form; throws PathError with a user-facing reason.
 */
export function normalizePath(input: string): string {
  const unified = input.normalize('NFC').replace(/\\/g, '/');
  const segments = unified.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) throw new PathError('Path is empty.');
  if (byteLength(segments.join('/')) > MAX_PATH_BYTES) {
    throw new PathError(`Path is longer than ${MAX_PATH_BYTES} bytes.`);
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new PathError('Path may not contain "." or ".." segments.');
    }
    if (segment.startsWith('.')) {
      throw new PathError(`"${segment}" may not begin with a dot.`);
    }
    if (CONTROL_CHARS.test(segment)) {
      throw new PathError('Path may not contain control characters.');
    }
    if (byteLength(segment) > MAX_SEGMENT_BYTES) {
      throw new PathError(`"${segment}" is longer than ${MAX_SEGMENT_BYTES} bytes.`);
    }
    const stem = segment.split('.')[0] ?? '';
    if (RESERVED_STEMS.has(stem.toLowerCase())) {
      throw new PathError(`"${stem}" is a reserved filename on Windows.`);
    }
  }

  return segments.join('/');
}

export function isNotePath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.md.enc');
}

export function isEncryptedPath(path: string): boolean {
  return path.endsWith('.md.enc');
}

/** Both states of a note share a stem, so wikilinks survive an encryption toggle. */
export function noteStem(path: string): string {
  return path.replace(/\.md(\.enc)?$/, '');
}

export function isReservedPath(path: string): boolean {
  return RESERVED_DIRS.some((dir) => path.startsWith(dir));
}

export function slugify(title: string): string {
  const cleaned = title
    .normalize('NFC')
    .replace(ILLEGAL_IN_NAME, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || 'untitled';
}
