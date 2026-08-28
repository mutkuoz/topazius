import { describe, expect, it } from 'vitest';
import { normalizePath } from '../src/lib/paths';
import { foldersIn, plannedPath } from '../src/ui/NoteDialogs';

/**
 * The rule these tests hold: nobody types a path, and nobody types `.md`.
 * A title is a title, and the app works out where the file goes.
 */
describe('plannedPath', () => {
  const path = (title: string, folder = '', encrypted = false) =>
    plannedPath({ title, folder, encrypted });

  it('puts a titled note in the chosen folder, with the extension added', () => {
    expect(path('Weekly standup', 'work')).toBe('work/Weekly standup.md');
    expect(path('Weekly standup')).toBe('Weekly standup.md');
  });

  it('keeps the title readable rather than slugging it into a machine name', () => {
    expect(path('Q3 OKRs — draft', 'work')).toBe('work/Q3 OKRs — draft.md');
  });

  it('reads a slash in the title as the folder the user meant', () => {
    expect(path('work/Weekly standup')).toBe('work/Weekly standup.md');
    expect(path('2026/Weekly standup', 'work')).toBe('work/2026/Weekly standup.md');
  });

  it('does not double an extension the user typed anyway', () => {
    expect(path('notes.md', 'work')).toBe('work/notes.md');
    expect(path('secret.md.enc', 'work', true)).toBe('work/secret.md.enc');
  });

  it('uses the encrypted extension when the note is to be sealed', () => {
    expect(path('Therapy', 'journal', true)).toBe('journal/Therapy.md.enc');
  });

  it('tidies a folder path without making the user do it', () => {
    expect(path('Note', 'work//2026/')).toBe('work/2026/Note.md');
    expect(path('Note', '  ')).toBe('Note.md');
  });

  it('never produces a path the vault would reject', () => {
    const awkward = ['', '   ', '...', 'a/b:c*d', 'CON', '/leading', 'trailing/'];
    for (const title of awkward) {
      const planned = path(title, 'work');
      expect(() => normalizePath(planned), planned).not.toThrow();
    }
  });

  it('falls back to a name rather than an empty file name', () => {
    expect(path('', 'work')).toBe('work/Untitled.md');
  });
});

describe('foldersIn', () => {
  it('lists every folder and every folder above it, sorted', () => {
    expect(foldersIn(['work/2026/a.md', 'recipes/b.md', 'c.md'])).toEqual([
      'recipes',
      'work',
      'work/2026',
    ]);
  });

  it('is empty for a flat vault', () => {
    expect(foldersIn(['a.md', 'b.md'])).toEqual([]);
  });
});
