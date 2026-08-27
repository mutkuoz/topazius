import { useState } from 'preact/hooks';
import { type TreeNode, buildTree } from '../lib/tree';

export interface TreeProps {
  paths: string[];
  selected: string | null;
  onSelect: (path: string) => void;
}

interface RowsProps {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}

function Rows({ nodes, depth, collapsed, toggle, selected, onSelect }: RowsProps) {
  return (
    <ul role="group">
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <li key={node.path} role="treeitem" aria-expanded={!collapsed.has(node.path)}>
            <button
              type="button"
              class="row folder"
              style={{ paddingInlineStart: `${depth * 0.85 + 0.5}rem` }}
              onClick={() => toggle(node.path)}
            >
              <span aria-hidden="true">{collapsed.has(node.path) ? '>' : 'v'}</span> {node.name}
            </button>
            {!collapsed.has(node.path) && (
              <Rows
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                toggle={toggle}
                selected={selected}
                onSelect={onSelect}
              />
            )}
          </li>
        ) : (
          <li key={node.path} role="treeitem" aria-selected={selected === node.path}>
            <button
              type="button"
              class={`row note${selected === node.path ? ' selected' : ''}`}
              style={{ paddingInlineStart: `${depth * 0.85 + 1.4}rem` }}
              onClick={() => onSelect(node.path)}
            >
              {node.name}
              {node.encrypted && (
                <span class="badge" title="Encrypted">
                  enc
                </span>
              )}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

export function Tree({ paths, selected, onSelect }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  if (paths.length === 0) {
    return <p class="hint">No notes yet.</p>;
  }

  return (
    <nav role="tree" aria-label="Notes">
      <Rows
        nodes={buildTree(paths)}
        depth={0}
        collapsed={collapsed}
        toggle={toggle}
        selected={selected}
        onSelect={onSelect}
      />
    </nav>
  );
}
