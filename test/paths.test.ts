import { describe, expect, it } from 'vitest';
import {
  MAX_PATH_BYTES,
  MAX_SEGMENT_BYTES,
  PathError,
  isEncryptedPath,
  isNotePath,
  isReservedPath,
  normalizePath,
  noteStem,
  slugify,
} from '../src/lib/paths';

describe('normalizePath', () => {
  it('accepts and returns a plain vault-relative path', () => {
    expect(normalizePath('work/standup.md')).toBe('work/standup.md');
  });

  it('strips redundant and leading slashes', () => {
    expect(normalizePath('/work//standup.md')).toBe('work/standup.md');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('work\\standup.md')).toBe('work/standup.md');
  });

  it('normalises to Unicode NFC', () => {
    expect(normalizePath('notes/cafe\u0301.md')).toBe('notes/café.md');
  });

  it('rejects directory traversal', () => {
    expect(() => normalizePath('../secrets.md')).toThrow(PathError);
    expect(() => normalizePath('work/../../secrets.md')).toThrow(PathError);
    expect(() => normalizePath('work/../notes.md')).toThrow(PathError);
  });

  it('rejects a segment beginning with a dot', () => {
    expect(() => normalizePath('.topazius/vault.json')).toThrow(PathError);
    expect(() => normalizePath('work/.hidden.md')).toThrow(PathError);
  });

  it('rejects control characters', () => {
    expect(() => normalizePath('work/a\u0000b.md')).toThrow(PathError);
    expect(() => normalizePath('work/a\u0001b.md')).toThrow(PathError);
    expect(() => normalizePath('work/a\nb.md')).toThrow(PathError);
    expect(() => normalizePath('work/a\u007Fb.md')).toThrow(PathError);
  });

  it('rejects Windows-reserved stems in any case', () => {
    expect(() => normalizePath('CON.md')).toThrow(PathError);
    expect(() => normalizePath('work/nul.md')).toThrow(PathError);
    expect(() => normalizePath('work/LPT9.md')).toThrow(PathError);
  });

  it('accepts a name that merely contains a reserved word', () => {
    expect(normalizePath('work/console.md')).toBe('work/console.md');
  });

  it('enforces the byte limits', () => {
    const longSegment = 'a'.repeat(MAX_SEGMENT_BYTES) + '.md';
    expect(() => normalizePath(longSegment)).toThrow(PathError);

    const deep = Array.from({ length: 60 }, () => 'abcdefgh').join('/') + '/x.md';
    expect(deep.length).toBeGreaterThan(MAX_PATH_BYTES);
    expect(() => normalizePath(deep)).toThrow(PathError);
  });

  it('counts limits in bytes, not code units', () => {
    // Each 'ä' is two UTF-8 bytes, so 120 of them exceed a 200-byte segment.
    expect(() => normalizePath('ä'.repeat(120) + '.md')).toThrow(PathError);
  });

  it('rejects an empty path', () => {
    expect(() => normalizePath('')).toThrow(PathError);
    expect(() => normalizePath('///')).toThrow(PathError);
  });
});

describe('note path predicates', () => {
  it('recognises both note forms', () => {
    expect(isNotePath('work/a.md')).toBe(true);
    expect(isNotePath('work/a.md.enc')).toBe(true);
    expect(isNotePath('assets/x.png')).toBe(false);
    expect(isNotePath('README.markdown')).toBe(false);
  });

  it('distinguishes encrypted notes', () => {
    expect(isEncryptedPath('work/a.md.enc')).toBe(true);
    expect(isEncryptedPath('work/a.md')).toBe(false);
  });

  it('collapses both forms to the same stem, so wikilinks survive toggling', () => {
    expect(noteStem('work/a.md')).toBe('work/a');
    expect(noteStem('work/a.md.enc')).toBe('work/a');
  });

  it('treats reserved directories as hidden', () => {
    expect(isReservedPath('assets/2026/08/x.png')).toBe(true);
    expect(isReservedPath('.topazius/vault.json')).toBe(true);
    expect(isReservedPath('work/assets-review.md')).toBe(false);
  });
});

describe('slugify', () => {
  it('collapses whitespace to hyphens', () => {
    expect(slugify('  Standup   Notes ')).toBe('Standup-Notes');
  });

  it('strips characters that are illegal in paths', () => {
    expect(slugify('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi');
  });

  it('collapses and trims hyphen runs', () => {
    expect(slugify('a --- b')).toBe('a-b');
    expect(slugify('---edge---')).toBe('edge');
  });

  it('falls back to a usable name when nothing survives', () => {
    expect(slugify('///')).toBe('untitled');
    expect(slugify('')).toBe('untitled');
  });
});
