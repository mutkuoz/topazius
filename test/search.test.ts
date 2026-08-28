import { describe, expect, it } from 'vitest';
import { createSearch, indexNote, subsequenceScore } from '../src/lib/search';

const notes: Array<[string, string]> = [
  [
    'work/standup.md',
    ['---', 'title: Standup notes', 'tags: [work, weekly]', '---', '', '# Monday', '', 'shipped the parser'].join(
      '\n',
    ),
  ],
  ['work/roadmap.md', '# Roadmap\n\nship the editor in August #planning'],
  ['recipes/pizza.md', '# Pizza\n\ndough, tomato, basil'],
  ['journal/aug.md.enc', '# August\n\nquiet week'],
];

const index = () => createSearch(notes.map(([path, source]) => indexNote(path, source)));

describe('indexNote', () => {
  it('takes the title from frontmatter, the tags from both places, and the body without the block', () => {
    const note = indexNote(...(notes[0] as [string, string]));
    expect(note.title).toBe('Standup notes');
    expect(note.tags).toEqual(['work', 'weekly']);
    expect(note.body).not.toContain('title:');
    expect(note.encrypted).toBe(false);
  });

  it('falls back to the first heading, then the filename', () => {
    expect(indexNote('a/b.md', '# From heading').title).toBe('From heading');
    expect(indexNote('a/b.md', 'no heading here').title).toBe('b');
  });

  it('marks a sealed note as encrypted', () => {
    expect(indexNote('journal/aug.md.enc', '# August').encrypted).toBe(true);
  });
});

describe('search', () => {
  it('finds a note by body text', () => {
    expect(index().search('basil').map((hit) => hit.path)).toEqual(['recipes/pizza.md']);
  });

  it('finds a note by title and by tag', () => {
    expect(index().search('standup')[0]?.path).toBe('work/standup.md');
    expect(index().search('weekly')[0]?.path).toBe('work/standup.md');
  });

  it('matches on a prefix, so results appear while typing', () => {
    expect(index().search('roadm')[0]?.path).toBe('work/roadmap.md');
  });

  it('tolerates a typo', () => {
    expect(index().search('tomatoe')[0]?.path).toBe('recipes/pizza.md');
  });

  it('requires every term to match', () => {
    expect(index().search('pizza roadmap')).toEqual([]);
  });

  it('searches encrypted notes like any other, because they are decrypted in memory', () => {
    expect(index().search('quiet')[0]?.path).toBe('journal/aug.md.enc');
  });

  it('returns nothing for an empty query', () => {
    expect(index().search('   ')).toEqual([]);
  });

  it('reports a snippet with the match highlighted', () => {
    const [hit] = index().search('basil');
    expect(hit?.snippet).toContain('basil');
    const [range] = hit?.matches ?? [];
    expect(hit?.snippet.slice(range?.[0], range?.[1]).toLowerCase()).toBe('basil');
  });

  it('does not treat the query as a regular expression', () => {
    expect(() => index().search('a(b')).not.toThrow();
  });
});

describe('incremental updates', () => {
  it('picks up an edit without a rebuild', () => {
    const search = index();
    expect(search.search('sourdough')).toEqual([]);

    search.update(indexNote('recipes/pizza.md', '# Pizza\n\nsourdough starter'));

    expect(search.search('sourdough').map((hit) => hit.path)).toEqual(['recipes/pizza.md']);
    expect(search.search('basil')).toEqual([]);
    expect(search.size()).toBe(4);
  });

  it('adds a new note', () => {
    const search = index();
    search.update(indexNote('inbox/idea.md', '# Idea\n\nteleportation'));
    expect(search.search('teleportation')[0]?.path).toBe('inbox/idea.md');
    expect(search.size()).toBe(5);
  });

  it('forgets a deleted note', () => {
    const search = index();
    search.remove('recipes/pizza.md');
    expect(search.search('basil')).toEqual([]);
    expect(search.size()).toBe(3);
    expect(() => search.remove('recipes/pizza.md')).not.toThrow();
  });
});

describe('quick open', () => {
  it('matches a subsequence of the path', () => {
    expect(index().quickOpen('wsu')[0]?.path).toBe('work/standup.md');
    expect(index().quickOpen('pizza')[0]?.path).toBe('recipes/pizza.md');
  });

  it('prefers consecutive matches', () => {
    expect(subsequenceScore('standup', 'stand')).toBeGreaterThan(subsequenceScore('sxtxaxnxd', 'stand'));
  });

  it('scores a miss as zero', () => {
    expect(subsequenceScore('standup', 'zzz')).toBe(0);
    expect(index().quickOpen('zzzz')).toEqual([]);
  });

  it('lists everything for an empty query, so ⌘K opens with the vault', () => {
    expect(index().quickOpen('')).toHaveLength(4);
  });
});
