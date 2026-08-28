import { useEffect, useRef, useState } from 'preact/hooks';
import { type TreeNode, buildTree } from '../lib/tree';

export type TreeAction =
  | { kind: 'new'; folder: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'encrypt'; path: string; on: boolean }
  | { kind: 'encrypt-folder'; folder: string; on: boolean }
  | { kind: 'folder-default'; folder: string; value: 'plain' | 'encrypted' }
  | { kind: 'move'; path: string; folder: string };

export interface TreeProps {
  paths: string[];
  selected: string | null;
  /** Paths with unsynced local edits, marked with a dot. */
  dirty?: string[];
  /** A folder's creation default, for the context menu (spec §9.5). */
  folderDefault?: (folder: string) => 'plain' | 'encrypted';
  onSelect: (path: string) => void;
  onAction?: (action: TreeAction) => void;
}

interface RowsProps extends Required<Pick<TreeProps, 'onSelect'>> {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  dirty: Set<string>;
  onAction?: (action: TreeAction) => void;
  onMenu: (target: { node: TreeNode; x: number; y: number }) => void;
}

function Rows({ nodes, depth, collapsed, toggle, selected, dirty, onSelect, onAction, onMenu }: RowsProps) {
  return (
    <ul role="group">
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <li key={node.path} role="treeitem" aria-expanded={!collapsed.has(node.path)}>
            <button
              type="button"
              class="row folder"
              data-folder={node.path}
              style={{ paddingInlineStart: `${depth * 0.85 + 0.5}rem` }}
              onClick={() => toggle(node.path)}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu({ node, x: event.clientX, y: event.clientY });
              }}
              onDragOver={(event) => {
                if (!onAction) return;
                event.preventDefault();
                event.currentTarget.classList.add('drop-target');
              }}
              onDragLeave={(event) => event.currentTarget.classList.remove('drop-target')}
              onDrop={(event) => {
                event.currentTarget.classList.remove('drop-target');
                const path = event.dataTransfer?.getData('text/topazius-note');
                if (path) onAction?.({ kind: 'move', path, folder: node.path });
              }}
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
                dirty={dirty}
                onSelect={onSelect}
                onAction={onAction}
                onMenu={onMenu}
              />
            )}
          </li>
        ) : (
          <li key={node.path} role="treeitem" aria-selected={selected === node.path}>
            <button
              type="button"
              class={`row note${selected === node.path ? ' selected' : ''}`}
              data-path={node.path}
              style={{ paddingInlineStart: `${depth * 0.85 + 1.4}rem` }}
              draggable={onAction !== undefined}
              onClick={() => onSelect(node.path)}
              onDragStart={(event) => event.dataTransfer?.setData('text/topazius-note', node.path)}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu({ node, x: event.clientX, y: event.clientY });
              }}
            >
              {node.name}
              {dirty.has(node.path) && (
                <span class="dot" title="Not yet saved to GitHub" aria-label="unsaved">
                  •
                </span>
              )}
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

interface MenuTarget {
  node: TreeNode;
  x: number;
  y: number;
}

export function Tree({ paths, selected, dirty = [], folderDefault, onSelect, onAction }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const container = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);

  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  /**
   * Arrow-key navigation over the rendered rows (spec §11.5). Walking the DOM
   * rather than the model keeps "next visible row" honest when folders are
   * collapsed.
   */
  function onKeyDown(event: KeyboardEvent) {
    const rows = [...(container.current?.querySelectorAll<HTMLButtonElement>('button.row') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;

    const current = rows[index];
    const path = current?.getAttribute('data-path') ?? null;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (!current?.classList.contains('folder')) return;
      event.preventDefault();
      const folderPath = current.getAttribute('data-folder');
      if (!folderPath) return;
      const isCollapsed = collapsed.has(folderPath);
      if (event.key === 'ArrowRight' ? isCollapsed : !isCollapsed) toggle(folderPath);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      if (path) {
        event.preventDefault();
        onSelect(path);
      }
    }
  }

  if (paths.length === 0) {
    return (
      <div class="tree-empty">
        <p class="hint">No notes yet.</p>
        {onAction && (
          <button type="button" class="linkish" onClick={() => onAction({ kind: 'new', folder: '' })}>
            Create your first note
          </button>
        )}
      </div>
    );
  }

  return (
    <nav
      role="tree"
      aria-label="Notes"
      ref={container}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        // A right-click on the empty area below the tree still offers "new
        // note", which is where people reach for it.
        if (event.target !== event.currentTarget || !onAction) return;
        event.preventDefault();
        setMenu({
          node: { name: '', path: '', kind: 'folder', encrypted: false, children: [] },
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <Rows
        nodes={buildTree(paths)}
        depth={0}
        collapsed={collapsed}
        toggle={toggle}
        selected={selected}
        dirty={new Set(dirty)}
        onSelect={onSelect}
        onAction={onAction}
        onMenu={setMenu}
      />

      {menu && onAction && (
        <div
          class="context-menu"
          role="menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          {menu.node.kind === 'folder' ? (
            <>
              <button type="button" role="menuitem" onClick={() => act({ kind: 'new', folder: menu.node.path })}>
                New note here
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => act({ kind: 'encrypt-folder', folder: menu.node.path, on: true })}
              >
                Encrypt every note in this folder
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => act({ kind: 'encrypt-folder', folder: menu.node.path, on: false })}
              >
                Decrypt this folder
              </button>
              {folderDefault && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    act({
                      kind: 'folder-default',
                      folder: menu.node.path,
                      value: folderDefault(menu.node.path) === 'encrypted' ? 'plain' : 'encrypted',
                    })
                  }
                >
                  {folderDefault(menu.node.path) === 'encrypted'
                    ? 'Create new notes here plain'
                    : 'Create new notes here encrypted'}
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => act({ kind: 'rename', path: menu.node.path })}>
                Rename or move…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  act({ kind: 'encrypt', path: menu.node.path, on: !menu.node.encrypted })
                }
              >
                {menu.node.encrypted ? 'Decrypt this note' : 'Encrypt this note'}
              </button>
              <button
                type="button"
                role="menuitem"
                class="danger"
                onClick={() => act({ kind: 'delete', path: menu.node.path })}
              >
                Delete…
              </button>
            </>
          )}
        </div>
      )}
    </nav>
  );

  function act(action: TreeAction) {
    setMenu(null);
    onAction?.(action);
  }
}
