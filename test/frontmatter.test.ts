import { describe, expect, it } from 'vitest';
import { parseNote, patchFrontmatter, resolveTitle, serializeNote } from '../src/lib/frontmatter';

const WITH_FM = `---
title: Standup notes
# a comment the user wrote
tags: [work, weekly]
custom_key: something we do not understand
created: 2026-08-27T09:14:00Z
---

# Monday

- shipped the thing
`;

const NO_FM = `# Just a heading

Body text.
`;

describe('parseNote', () => {
  it('splits frontmatter from body', () => {
    const parsed = parseNote(WITH_FM);
    expect(parsed.fields.title).toBe('Standup notes');
    expect(parsed.fields.tags).toEqual(['work', 'weekly']);
    expect(parsed.fields.created).toBe('2026-08-27T09:14:00Z');
    expect(parsed.body.startsWith('\n# Monday')).toBe(true);
  });

  it('reports an empty field set when there is no frontmatter', () => {
    const parsed = parseNote(NO_FM);
    expect(parsed.fmBlock).toBe('');
    expect(parsed.fields.tags).toEqual([]);
    expect(parsed.fields.title).toBeUndefined();
    expect(parsed.body).toBe(NO_FM);
  });

  it('reads the block list form of tags', () => {
    const parsed = parseNote(`---\ntags:\n  - alpha\n  - beta\n---\nbody\n`);
    expect(parsed.fields.tags).toEqual(['alpha', 'beta']);
  });

  it('strips quotes from scalar values', () => {
    const parsed = parseNote(`---\ntitle: "Quoted Title"\n---\nbody\n`);
    expect(parsed.fields.title).toBe('Quoted Title');
  });

  it('does not treat a horizontal rule as frontmatter', () => {
    const source = `Some text\n\n---\n\nMore text\n`;
    const parsed = parseNote(source);
    expect(parsed.fmBlock).toBe('');
    expect(parsed.body).toBe(source);
  });

  it('ignores an unterminated frontmatter fence', () => {
    const source = `---\ntitle: nope\n\nstill going\n`;
    const parsed = parseNote(source);
    expect(parsed.fmBlock).toBe('');
    expect(parsed.body).toBe(source);
  });
});

describe('serializeNote', () => {
  it('round-trips a note with frontmatter byte-identically', () => {
    expect(serializeNote(parseNote(WITH_FM))).toBe(WITH_FM);
  });

  it('round-trips a note without frontmatter byte-identically', () => {
    expect(serializeNote(parseNote(NO_FM))).toBe(NO_FM);
  });

  it('preserves CRLF line endings', () => {
    const crlf = `---\r\ntitle: Windows\r\n---\r\nbody\r\n`;
    expect(serializeNote(parseNote(crlf))).toBe(crlf);
  });
});

describe('patchFrontmatter', () => {
  it('rewrites only the line that changed', () => {
    const out = patchFrontmatter(WITH_FM, { title: 'Renamed' });
    expect(out).toContain('title: Renamed');
    expect(out).toContain('# a comment the user wrote');
    expect(out).toContain('custom_key: something we do not understand');
    expect(out).toContain('tags: [work, weekly]');
    expect(out.split('\n').length).toBe(WITH_FM.split('\n').length);
  });

  it('appends a key that was absent, before the closing fence', () => {
    const out = patchFrontmatter(WITH_FM, { updated: '2026-08-27T11:02:00Z' });
    const lines = out.split('\n');
    const fence = lines.indexOf('---', 1);
    expect(lines[fence - 1]).toBe('updated: 2026-08-27T11:02:00Z');
  });

  it('creates a frontmatter block when the note has none', () => {
    const out = patchFrontmatter(NO_FM, { tags: ['new'] });
    expect(out.startsWith('---\ntags: [new]\n---\n')).toBe(true);
    expect(out.endsWith(NO_FM)).toBe(true);
  });

  it('writes tags back in inline form', () => {
    expect(patchFrontmatter(WITH_FM, { tags: ['a', 'b'] })).toContain('tags: [a, b]');
  });

  it('is a no-op when nothing actually changed', () => {
    expect(patchFrontmatter(WITH_FM, {})).toBe(WITH_FM);
  });

  it('leaves the body untouched', () => {
    const out = patchFrontmatter(WITH_FM, { title: 'Renamed' });
    expect(out).toContain('- shipped the thing');
  });
});

describe('resolveTitle', () => {
  it('prefers frontmatter title', () => {
    expect(resolveTitle('work/standup.md', parseNote(WITH_FM))).toBe('Standup notes');
  });

  it('falls back to the first H1', () => {
    expect(resolveTitle('work/x.md', parseNote(NO_FM))).toBe('Just a heading');
  });

  it('falls back to the filename stem, including for encrypted notes', () => {
    expect(resolveTitle('work/my-note.md', parseNote('no heading here\n'))).toBe('my-note');
    expect(resolveTitle('work/my-note.md.enc', parseNote('no heading\n'))).toBe('my-note');
  });
});
