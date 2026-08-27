import { describe, expect, it } from 'vitest';
import { buildLinkGraph, parseWikilinks, resolveLink, rewriteLinks, updateLinksFor } from '../src/lib/links';

describe('parseWikilinks', () => {
  it('reads plain links and aliases', () => {
    expect(parseWikilinks('see [[work/roadmap]] and [[pizza|the recipe]]').map((l) => [l.target, l.label])).toEqual(
      [
        ['work/roadmap', 'work/roadmap'],
        ['pizza', 'the recipe'],
      ],
    );
  });

  it('reports the exact offset of each link', () => {
    const body = 'a [[one]] b';
    const [link] = parseWikilinks(body);
    expect(body.slice(link?.index, (link?.index ?? 0) + (link?.length ?? 0))).toBe('[[one]]');
  });

  it('ignores links inside code', () => {
    expect(parseWikilinks('`[[nope]]` and\n```\n[[also-nope]]\n```\n[[yes]]').map((l) => l.target)).toEqual([
      'yes',
    ]);
  });

  it('ignores an empty target and an unterminated link', () => {
    expect(parseWikilinks('[[]] and [[ | x]] and [[open')).toEqual([]);
  });

  it('falls back to the target when an alias is blank', () => {
    expect(parseWikilinks('[[note|]]')[0]?.label).toBe('note');
  });
});

describe('resolveLink', () => {
  const paths = ['work/roadmap.md', 'work/standup.md', 'recipes/pizza.md', 'journal/aug.md.enc'];

  it('matches a full path with or without the extension', () => {
    expect(resolveLink('work/roadmap', paths)).toBe('work/roadmap.md');
    expect(resolveLink('work/roadmap.md', paths)).toBe('work/roadmap.md');
  });

  it('matches a unique basename', () => {
    expect(resolveLink('pizza', paths)).toBe('recipes/pizza.md');
  });

  it('resolves the same whether the note is sealed or plain', () => {
    expect(resolveLink('journal/aug', paths)).toBe('journal/aug.md.enc');
    expect(resolveLink('aug', paths)).toBe('journal/aug.md.enc');
  });

  it('refuses to guess when a basename is ambiguous', () => {
    expect(resolveLink('notes', ['a/notes.md', 'b/notes.md'])).toBeNull();
  });

  it('is case-insensitive and tolerates a leading slash', () => {
    expect(resolveLink('/WORK/Roadmap', paths)).toBe('work/roadmap.md');
  });

  it('returns null for a target that is nowhere in the vault', () => {
    expect(resolveLink('nothing/here', paths)).toBeNull();
  });
});

describe('buildLinkGraph', () => {
  const notes = [
    { path: 'work/standup.md', body: 'today: see [[work/roadmap]] and [[pizza|dinner]]' },
    { path: 'work/roadmap.md', body: 'the plan\n\nlinks back to [[work/standup]]' },
    { path: 'recipes/pizza.md', body: 'dough\n\n[[does-not-exist]]' },
  ];

  it('lists who links to each note, with context', () => {
    const { backlinks } = buildLinkGraph(notes);
    expect(backlinks.get('work/roadmap.md')).toEqual([
      { from: 'work/standup.md', label: 'work/roadmap', context: 'today: see [[work/roadmap]] and [[pizza|dinner]]' },
    ]);
    expect(backlinks.get('recipes/pizza.md')?.[0]?.label).toBe('dinner');
  });

  it('collects unresolved targets so the UI can offer to create them', () => {
    const { missing } = buildLinkGraph(notes);
    expect(missing.get('does-not-exist')).toEqual(['recipes/pizza.md']);
  });

  it('does not count a note linking to itself', () => {
    const { backlinks } = buildLinkGraph([{ path: 'a.md', body: '[[a]]' }]);
    expect(backlinks.get('a.md')).toBeUndefined();
  });
});

describe('updateLinksFor', () => {
  const notes = [
    { path: 'a.md', body: 'see [[b]]' },
    { path: 'b.md', body: 'nothing here' },
    { path: 'c.md', body: 'also [[b]]' },
  ];
  const paths = notes.map((note) => note.path);

  it('matches a full rebuild after an edit', () => {
    const graph = buildLinkGraph(notes);
    updateLinksFor(graph, 'a.md', 'now points at [[c]]', paths);

    const rebuilt = buildLinkGraph([{ path: 'a.md', body: 'now points at [[c]]' }, ...notes.slice(1)]);
    expect(graph.backlinks).toEqual(rebuilt.backlinks);
    expect(graph.missing).toEqual(rebuilt.missing);
  });

  it('leaves other notes’ links in place', () => {
    const graph = buildLinkGraph(notes);
    updateLinksFor(graph, 'a.md', 'no links now', paths);
    expect(graph.backlinks.get('b.md')?.map((link) => link.from)).toEqual(['c.md']);
  });

  it('drops the last backlink to a note rather than leaving an empty list', () => {
    const graph = buildLinkGraph([notes[0] as { path: string; body: string }, notes[1] as { path: string; body: string }]);
    updateLinksFor(graph, 'a.md', 'no links now', ['a.md', 'b.md']);
    expect(graph.backlinks.has('b.md')).toBe(false);
  });

  it('tracks a link that has become missing, and one that has been resolved', () => {
    const graph = buildLinkGraph(notes);
    updateLinksFor(graph, 'a.md', 'see [[nowhere]]', paths);
    expect(graph.missing.get('nowhere')).toEqual(['a.md']);

    updateLinksFor(graph, 'a.md', 'see [[b]] again', paths);
    expect(graph.missing.has('nowhere')).toBe(false);
    expect(graph.backlinks.get('b.md')?.map((link) => link.from).sort()).toEqual(['a.md', 'c.md']);
  });
});

describe('rewriteLinks', () => {
  const paths = ['work/standup.md', 'recipes/pizza.md'];

  it('rewrites a full-path link to the new location', () => {
    expect(rewriteLinks('see [[work/standup]] now', 'work/standup.md', 'archive/standup.md', paths)).toBe(
      'see [[archive/standup]] now',
    );
  });

  it('keeps the alias', () => {
    expect(rewriteLinks('[[work/standup|yesterday]]', 'work/standup.md', 'archive/standup.md', paths)).toBe(
      '[[archive/standup|yesterday]]',
    );
  });

  it('keeps a basename link short while it stays unambiguous', () => {
    expect(rewriteLinks('[[pizza]]', 'recipes/pizza.md', 'food/pizza.md', paths)).toBe('[[pizza]]');
  });

  it('expands a basename link to a full path when the move makes it ambiguous', () => {
    // `margherita` is unique until this rename creates a second one.
    const crowded = ['recipes/pizza.md', 'food/margherita.md'];
    expect(rewriteLinks('[[pizza]]', 'recipes/pizza.md', 'archive/margherita.md', crowded)).toBe(
      '[[archive/margherita]]',
    );
  });

  it('leaves a link that was already ambiguous alone, because it never pointed here', () => {
    const crowded = ['recipes/pizza.md', 'food/pizza.md'];
    expect(rewriteLinks('[[pizza]]', 'recipes/pizza.md', 'archive/pizza.md', crowded)).toBe('[[pizza]]');
  });

  it('leaves links to other notes alone', () => {
    const body = '[[recipes/pizza]] and [[work/standup]]';
    expect(rewriteLinks(body, 'work/standup.md', 'archive/standup.md', paths)).toBe(
      '[[recipes/pizza]] and [[archive/standup]]',
    );
  });

  it('returns the body unchanged when nothing points at the renamed note', () => {
    const body = 'no links here at all';
    expect(rewriteLinks(body, 'work/standup.md', 'archive/standup.md', paths)).toBe(body);
  });

  it('follows the note across an encryption toggle', () => {
    expect(rewriteLinks('[[work/standup]]', 'work/standup.md', 'work/standup.md.enc', paths)).toBe(
      '[[work/standup]]',
    );
  });
});
