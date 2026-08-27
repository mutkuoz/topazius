import { describe, expect, it } from 'vitest';
import { inlineTags, noteTags, tagCounts } from '../src/lib/tags';

describe('inlineTags', () => {
  it('finds a tag in prose', () => {
    expect(inlineTags('see #planning and #work/private today')).toEqual(['planning', 'work/private']);
  });

  it('requires a letter after the hash', () => {
    expect(inlineTags('issue #123 and # alone and #1st')).toEqual([]);
    // Spec §4.2 draws the line at "a letter", so a hex colour written in prose
    // is a tag. Cheap to un-tag by hand; a smarter rule would guess wrong the
    // other way on real tags like #fixed or #dead.
    expect(inlineTags('colour #fff')).toEqual(['fff']);
  });

  it('ignores headings, which is what a line-leading hash means', () => {
    expect(inlineTags('# Monday\n\n## Notes\n\nbut #real counts')).toEqual(['real']);
  });

  it('ignores fenced code', () => {
    const body = ['before #yes', '', '```sh', '# not a tag', 'echo #nope', '```', '', 'after #also'].join('\n');
    expect(inlineTags(body)).toEqual(['yes', 'also']);
  });

  it('ignores tilde fences and indented code', () => {
    expect(inlineTags('~~~\n#nope\n~~~\n\n    #indented\n\n#yes')).toEqual(['yes']);
  });

  it('ignores inline code spans', () => {
    expect(inlineTags('run `grep #nope` then tag #yes')).toEqual(['yes']);
  });

  it('does not treat a hash glued to a word as a tag', () => {
    expect(inlineTags('issue1#two and C#')).toEqual([]);
  });

  it('drops trailing punctuation from the tag name', () => {
    expect(inlineTags('at the end #work.')).toEqual(['work']);
    expect(inlineTags('a #work- b')).toEqual(['work']);
  });
});

describe('noteTags', () => {
  it('unions frontmatter and inline tags', () => {
    const source = ['---', 'tags: [work, weekly]', '---', '', '# Monday', '', 'see #planning'].join('\n');
    expect(noteTags(source)).toEqual(['work', 'weekly', 'planning']);
  });

  it('reads the block list form of frontmatter tags', () => {
    const source = ['---', 'tags:', '  - work', '  - weekly', '---', '', 'body'].join('\n');
    expect(noteTags(source)).toEqual(['work', 'weekly']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    const source = ['---', 'tags: [Work]', '---', '', 'also #work and #WORK'].join('\n');
    expect(noteTags(source)).toEqual(['Work']);
  });

  it('does not mistake the frontmatter fence for a heading or a tag', () => {
    expect(noteTags('---\ntitle: Test\n---\n\nplain body')).toEqual([]);
  });
});

describe('tagCounts', () => {
  it('counts each tag once per note, most used first', () => {
    const counts = tagCounts([
      { tags: ['work', 'work', 'idea'] },
      { tags: ['work'] },
      { tags: ['idea'] },
      { tags: ['alone'] },
    ]);
    expect(counts).toEqual([
      { tag: 'idea', count: 2 },
      { tag: 'work', count: 2 },
      { tag: 'alone', count: 1 },
    ]);
  });
});
