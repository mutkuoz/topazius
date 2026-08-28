export const MAX_SEGMENT_BYTES = 200;
export const MAX_PATH_BYTES = 400;

const RESERVED_DIRS = ['assets/', '.topazius/'];

const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// A separate global copy for stripping: a /g regex carries lastIndex between
// calls, so sharing one with the .test() above would make that check answer
// differently on alternate invocations.
const CONTROL_CHARS_ALL = /[\u0000-\u001F\u007F]/g;
const ILLEGAL_IN_NAME = /[/\\:*?"<>|]/g;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/** Sanitise a segment for safe error message interpolation. */
function sanitiseSegment(segment: string): string {
  const cleaned = segment.replace(CONTROL_CHARS_ALL, '');
  return cleaned.length > 40 ? cleaned.slice(0, 40) + '…' : cleaned;
}

/**
 * Normalise a vault-relative path and reject anything unsafe.
 * Returns the canonical form; throws PathError with a user-facing reason.
 */
export function normalizePath(input: string): string {
  const unified = input.normalize('NFC').replace(/\\/g, '/');

  if (unified.startsWith('/')) {
    throw new PathError('Path must be relative to the vault root.');
  }

  const segments = unified.split('/');
  if (segments.length === 0 || segments.every((s) => s.length === 0)) {
    throw new PathError('Path is empty.');
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new PathError('Path may not contain empty segments.');
    }
  }

  if (byteLength(segments.join('/')) > MAX_PATH_BYTES) {
    throw new PathError(`Path is longer than ${MAX_PATH_BYTES} bytes.`);
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new PathError('Path may not contain "." or ".." segments.');
    }
    if (/^[A-Za-z]:$/.test(segment)) {
      throw new PathError('Path may not contain a drive letter.');
    }
    if (segment.startsWith('.')) {
      throw new PathError(`"${sanitiseSegment(segment)}" may not begin with a dot.`);
    }
    if (CONTROL_CHARS.test(segment)) {
      throw new PathError('Path may not contain control characters.');
    }
    if (byteLength(segment) > MAX_SEGMENT_BYTES) {
      throw new PathError(`"${sanitiseSegment(segment)}" is longer than ${MAX_SEGMENT_BYTES} bytes.`);
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

/**
 * A filename for a note the user titled `title`.
 *
 * Deliberately not slugify(): a note called "Weekly standup" becomes
 * `Weekly standup.md`, not `weekly-standup.md`. The filename *is* the title
 * when there is no frontmatter, this vault is opened by hand in Obsidian and
 * in `ls`, and a machine-looking name there is a worse answer than a space.
 * Only what a filesystem or a URL cannot carry is removed.
 */
export function titleToFileName(title: string): string {
  const cleaned = title
    .normalize('NFC')
    .replace(CONTROL_CHARS_ALL, '')
    .replace(ILLEGAL_IN_NAME, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100)
    .trim();

  if (cleaned === '' || RESERVED_STEMS.has(cleaned.split('.')[0]?.toLowerCase() ?? '')) {
    return cleaned === '' ? 'Untitled' : `${cleaned} note`;
  }
  return cleaned;
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
