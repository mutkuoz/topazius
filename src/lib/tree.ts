import { isEncryptedPath, noteStem } from './paths';

export interface TreeNode {
  /** Display name: the final segment, with .md or .md.enc stripped for notes. */
  name: string;
  /** Vault-relative path. For folders, the path of the folder itself. */
  path: string;
  kind: 'folder' | 'note';
  encrypted: boolean;
  children: TreeNode[];
}

function compare(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function sortDeep(nodes: TreeNode[]): TreeNode[] {
  nodes.sort(compare);
  for (const node of nodes) sortDeep(node.children);
  return nodes;
}

export function buildTree(paths: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();

  for (const path of paths) {
    const segments = path.split('/');
    const fileName = segments.pop();
    if (fileName === undefined) continue;

    let siblings = roots;
    let prefix = '';

    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { name: segment, path: prefix, kind: 'folder', encrypted: false, children: [] };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }

    siblings.push({
      name: noteStem(fileName),
      path,
      kind: 'note',
      encrypted: isEncryptedPath(path),
      children: [],
    });
  }

  return sortDeep(roots);
}
