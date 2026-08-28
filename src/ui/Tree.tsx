import { useRef, useState } from 'preact/hooks';
import { type TreeNode, buildTree } from '../lib/tree';
import { MenuButton } from './Menu';
import { MoreIcon, PlusIcon } from './icons';

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
  /** A folder's creation default, for its menu (spec §9.5). */
  folderDefault?: (folder: string) => 'plain' | 'encrypted';
  onSelect: (path: string) => void;
  onAction?: (action: TreeAction) => void;
}

interface RowsProps {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  dirty: Set<string>;
  folderDefault?: (folder: string) => 'plain' | 'encrypted';
  onSelect: (path: string) => void;
  onAction?: (action: TreeAction) => void;
}

/** What a folder row offers — as visible items, not as a right-click secret. */
function folderItems(
  folder: string,
  onAction: (action: TreeAction) => void,
  folderDefault?: (folder: string) => 'plain' | 'encrypted',
) {
  const encryptedByDefault = folderDefault?.(folder) === 'encrypted';
  return [
    { label: 'New note here', onSelect: () => onAction({ kind: 'new', folder }) },
    {
      label: 'Encrypt every note in this folder',
      onSelect: () => onAction({ kind: 'encrypt-folder', folder, on: true }),
    },
    {
      label: 'Decrypt this folder',
      onSelect: () => onAction({ kind: 'encrypt-folder', folder, on: false }),
    },
    ...(folderDefault
      ? [
          {
            label: encryptedByDefault
              ? 'Create new notes here plain'
              : 'Create new notes here encrypted',
            onSelect: () =>
              onAction({
                kind: 'folder-default',
                folder,
                value: encryptedByDefault ? ('plain' as const) : ('encrypted' as const),
              }),
          },
        ]
      : []),
  ];
}

function noteItems(node: TreeNode, onAction: (action: TreeAction) => void) {
  return [
    { label: 'Rename or move…', onSelect: () => onAction({ kind: 'rename', path: node.path }) },
    {
      label: node.encrypted ? 'Decrypt this note' : 'Encrypt this note',
      onSelect: () => onAction({ kind: 'encrypt', path: node.path, on: !node.encrypted }),
    },
    { label: 'Delete…', onSelect: () => onAction({ kind: 'delete', path: node.path }), danger: true },
  ];
}

function Rows({
  nodes,
  depth,
  collapsed,
  toggle,
  selected,
  dirty,
  folderDefault,
  onSelect,
  onAction,
}: RowsProps) {
  return (
    <ul role="group">
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <li key={node.path} role="treeitem" aria-expanded={!collapsed.has(node.path)}>
            <div
              class="row"
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
              <button
                type="button"
                class="row-main folder"
                data-folder={node.path}
                style={{ paddingInlineStart: `${depth * 0.85 + 0.4}rem` }}
                onClick={() => toggle(node.path)}
              >
                <span class="row-inner">
                  <span class="row-twisty" aria-hidden="true">
                    {collapsed.has(node.path) ? '›' : '⌄'}
                  </span>
                  <span class="row-label">{node.name}</span>
                </span>
              </button>

              {onAction && (
                <>
                  <button
                    type="button"
                    class="row-action"
                    aria-label={`New note in ${node.path}`}
                    title={`New note in ${node.path}`}
                    onClick={() => onAction({ kind: 'new', folder: node.path })}
                  >
                    <PlusIcon />
                  </button>
                  <span class="row-action">
                    <MenuButton
                      label={`Actions for ${node.path}`}
                      items={folderItems(node.path, onAction, folderDefault)}
                    >
                      <MoreIcon />
                    </MenuButton>
                  </span>
                </>
              )}
            </div>

            {!collapsed.has(node.path) && (
              <Rows
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                toggle={toggle}
                selected={selected}
                dirty={dirty}
                {...(folderDefault ? { folderDefault } : {})}
                onSelect={onSelect}
                {...(onAction ? { onAction } : {})}
              />
            )}
          </li>
        ) : (
          <li key={node.path} role="treeitem" aria-selected={selected === node.path}>
            <div class={`row${selected === node.path ? ' selected' : ''}`}>
              <button
                type="button"
                class="row-main note"
                data-path={node.path}
                style={{ paddingInlineStart: `${depth * 0.85 + 1.3}rem` }}
                draggable={onAction !== undefined}
                onClick={() => onSelect(node.path)}
                onDragStart={(event) => event.dataTransfer?.setData('text/topazius-note', node.path)}
              >
                <span class="row-inner">
                  <span class="row-label">{node.name}</span>
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
                </span>
              </button>

              {onAction && (
                <span class="row-action">
                  <MenuButton label={`Actions for ${node.name}`} items={noteItems(node, onAction)}>
                    <MoreIcon />
                  </MenuButton>
                </span>
              )}
            </div>
          </li>
        ),
      )}
    </ul>
  );
}

export function Tree({ paths, selected, dirty = [], folderDefault, onSelect, onAction }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const container = useRef<HTMLElement>(null);

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
    const rows = [...(container.current?.querySelectorAll<HTMLButtonElement>('button.row-main') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;

    const current = rows[index];
    const path = current?.getAttribute('data-path') ?? null;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const folder = current?.getAttribute('data-folder');
      if (!folder) return;
      event.preventDefault();
      const isCollapsed = collapsed.has(folder);
      if (event.key === 'ArrowRight' ? isCollapsed : !isCollapsed) toggle(folder);
      return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && path) {
      event.preventDefault();
      onSelect(path);
    }
  }

  if (paths.length === 0) {
    return (
      <div class="tree-empty">
        <p class="hint">Nothing here yet.</p>
        {onAction && (
          <button type="button" class="linkish" onClick={() => onAction({ kind: 'new', folder: '' })}>
            Write your first note
          </button>
        )}
      </div>
    );
  }

  return (
    <nav role="tree" aria-label="Notes" ref={container} onKeyDown={onKeyDown}>
      <Rows
        nodes={buildTree(paths)}
        depth={0}
        collapsed={collapsed}
        toggle={toggle}
        selected={selected}
        dirty={new Set(dirty)}
        {...(folderDefault ? { folderDefault } : {})}
        onSelect={onSelect}
        {...(onAction ? { onAction } : {})}
      />
    </nav>
  );
}
