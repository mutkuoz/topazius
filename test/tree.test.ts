import { describe, expect, it } from 'vitest';
import { buildTree } from '../src/lib/tree';

describe('buildTree', () => {
  it('nests notes under their folders', () => {
    const tree = buildTree(['work/standup.md', 'work/roadmap.md', 'inbox/idea.md']);

    expect(tree.map((n) => n.name)).toEqual(['inbox', 'work']);
    expect(tree[1]?.kind).toBe('folder');
    expect(tree[1]?.children.map((n) => n.name)).toEqual(['roadmap', 'standup']);
  });

  it('sorts folders before notes, each alphabetically', () => {
    const tree = buildTree(['zebra.md', 'work/a.md', 'apple.md', 'archive/b.md']);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'folder:archive',
      'folder:work',
      'note:apple',
      'note:zebra',
    ]);
  });

  it('handles arbitrarily deep nesting', () => {
    const tree = buildTree(['a/b/c/deep.md']);
    expect(tree[0]?.children[0]?.children[0]?.children[0]).toMatchObject({
      name: 'deep',
      path: 'a/b/c/deep.md',
      kind: 'note',
    });
  });

  it('strips both note extensions from display names and flags encrypted notes', () => {
    const tree = buildTree(['plain.md', 'sealed.md.enc']);
    expect(tree.map((n) => [n.name, n.encrypted])).toEqual([
      ['plain', false],
      ['sealed', true],
    ]);
  });

  it('gives folders their own vault-relative path', () => {
    const tree = buildTree(['a/b/c.md']);
    expect(tree[0]?.path).toBe('a');
    expect(tree[0]?.children[0]?.path).toBe('a/b');
  });

  it('reuses one folder node for sibling notes', () => {
    const tree = buildTree(['a/one.md', 'a/two.md']);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(2);
  });

  it('sorts case-insensitively so the tree reads naturally', () => {
    expect(buildTree(['Beta.md', 'alpha.md']).map((n) => n.name)).toEqual(['alpha', 'Beta']);
  });

  it('returns an empty array for an empty vault', () => {
    expect(buildTree([])).toEqual([]);
  });
});
