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
  titleToFileName,
} from '../src/lib/paths';

describe('normalizePath', () => {
  it('accepts and returns a plain vault-relative path', () => {
    expect(normalizePath('work/standup.md')).toBe('work/standup.md');
  });

  it('rejects absolute paths and empty segments', () => {
    expect(() => normalizePath('/work//standup.md')).toThrow(PathError);
    expect(() => normalizePath('/absolute.md')).toThrow(PathError);
    expect(() => normalizePath('work//standup.md')).toThrow(PathError);
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('work\\standup.md')).toBe('work/standup.md');
  });

  it('rejects Windows drive letters', () => {
    expect(() => normalizePath('C:\\Users\\foo\\bar.md')).toThrow(PathError);
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

describe('titleToFileName', () => {
  it('keeps the title as the user wrote it, spaces and case included', () => {
    expect(titleToFileName('Weekly standup')).toBe('Weekly standup');
    expect(titleToFileName('Q3 OKRs — draft')).toBe('Q3 OKRs — draft');
  });

  it('removes only what a filesystem or a URL cannot carry', () => {
    expect(titleToFileName('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi');
    expect(titleToFileName('tabs\tand\nnewlines')).toBe('tabsandnewlines');
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(titleToFileName('  spaced   out  ')).toBe('spaced out');
  });

  it('refuses to produce a leading dot, which paths.ts would then reject', () => {
    expect(titleToFileName('...hidden')).toBe('hidden');
  });

  it('falls back to a name when there is nothing left', () => {
    expect(titleToFileName('   ')).toBe('Untitled');
    expect(titleToFileName('///')).toBe('Untitled');
  });

  it('sidesteps the Windows reserved stems', () => {
    expect(titleToFileName('CON')).toBe('CON note');
    expect(titleToFileName('lpt1')).toBe('lpt1 note');
  });

  it('produces something normalizePath accepts', () => {
    for (const title of ['Weekly standup', 'a/b:c', '...hidden', 'CON', '   ']) {
      expect(() => normalizePath(`${titleToFileName(title)}.md`)).not.toThrow();
    }
  });
});
