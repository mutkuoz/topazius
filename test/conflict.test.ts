import { describe, expect, it } from 'vitest';
import { type Conflict, diffLines, hasDifferences, resolve, summarise } from '../src/lib/conflict';

const conflict: Conflict = {
  path: 'work/standup.md',
  local: '# Monday\n\nmine',
  remote: '# Monday\n\ntheirs',
  remoteSha: 'remote-sha',
  remoteMissing: false,
};

describe('resolve', () => {
  it('keep mine re-uploads the local text against the remote sha', () => {
    expect(resolve(conflict, { kind: 'mine' })).toEqual({
      text: conflict.local,
      sha: 'remote-sha',
      upload: true,
    });
  });

  it('keep theirs replaces the local copy and uploads nothing', () => {
    expect(resolve(conflict, { kind: 'theirs' })).toEqual({
      text: conflict.remote,
      sha: 'remote-sha',
      upload: false,
    });
  });

  it('merge uploads the merged text against the remote sha', () => {
    expect(resolve(conflict, { kind: 'merged', text: 'both' })).toEqual({
      text: 'both',
      sha: 'remote-sha',
      upload: true,
    });
  });

  it('never picks a side on its own - every outcome comes from an explicit choice', () => {
    // The three cases above are the whole API surface; there is no
    // resolve(conflict) that decides for the user.
    expect(Object.keys(resolve(conflict, { kind: 'mine' })).sort()).toEqual(['sha', 'text', 'upload']);
  });
});

describe('diffLines', () => {
  it('marks unchanged, added, and removed lines', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('reports nothing changed for identical text', () => {
    const diff = diffLines('a\nb', 'a\nb');
    expect(hasDifferences(diff)).toBe(false);
    expect(summarise(diff)).toBe('identical');
  });

  it('handles a pure insertion and a pure deletion', () => {
    expect(diffLines('a\nc', 'a\nb\nc').filter((line) => line.kind === 'added')).toEqual([
      { kind: 'added', text: 'b' },
    ]);
    expect(diffLines('a\nb\nc', 'a\nc').filter((line) => line.kind === 'removed')).toEqual([
      { kind: 'removed', text: 'b' },
    ]);
  });

  it('keeps the longest common subsequence rather than restating the file', () => {
    const diff = diffLines('one\ntwo\nthree\nfour', 'one\ntwo\nthree\nFOUR');
    expect(diff.filter((line) => line.kind === 'same')).toHaveLength(3);
  });

  it('summarises the shape of the change', () => {
    expect(summarise(diffLines('a\nb', 'a\nB\nC'))).toBe('2 lines added, 1 line removed');
  });

  it('degrades rather than freezing on an enormous note', () => {
    const big = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join('\n');
    const diff = diffLines(big, `${big}\nextra`);
    expect(diff).toHaveLength(2_500 + 2_501);
    expect(hasDifferences(diff)).toBe(true);
  });
});
