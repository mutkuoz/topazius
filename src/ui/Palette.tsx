import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { IndexedNote, VaultSearch } from '../lib/search';
import './palette.css';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export interface PaletteProps {
  search: VaultSearch;
  actions: PaletteAction[];
  onOpenNote: (path: string) => void;
  onClose: () => void;
}

type Row =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'note'; note: IndexedNote }
  | { kind: 'hit'; path: string; title: string; snippet: string };

const LIMIT = 8;

/**
 * ⌘K (spec §11.2): quick-open by path, full-text search across bodies, and the
 * app's actions, in one list. `>` runs actions only, `#` filters by tag, and
 * `enc:` lists every sealed note - the answer to "which notes are protected?"
 * that §11.1 asks to always be one keystroke away.
 */
export function Palette({ search, actions, onOpenNote, onClose }: PaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<Element | null>(null);

  const rows = useMemo((): Row[] => {
    const trimmed = query.trim();

    if (trimmed.startsWith('>')) {
      const term = trimmed.slice(1).trim().toLowerCase();
      return actions
        .filter((action) => action.label.toLowerCase().includes(term))
        .map((action) => ({ kind: 'action', action }));
    }

    if (trimmed.startsWith('enc:')) {
      return search
        .notes()
        .filter((note) => note.encrypted)
        .map((note) => ({ kind: 'note', note }));
    }

    if (trimmed.startsWith('#')) {
      const tag = trimmed.slice(1).toLowerCase();
      return search
        .notes()
        .filter((note) => note.tags.some((candidate) => candidate.toLowerCase().startsWith(tag)))
        .map((note) => ({ kind: 'note', note }));
    }

    const quick = search.quickOpen(trimmed, LIMIT).map((note): Row => ({ kind: 'note', note }));
    if (trimmed === '') {
      return [...quick, ...actions.map((action): Row => ({ kind: 'action', action }))];
    }

    const seen = new Set(quick.map((row) => (row.kind === 'note' ? row.note.path : '')));
    const hits = search
      .search(trimmed, LIMIT)
      .filter((hit) => !seen.has(hit.path))
      .map((hit): Row => ({ kind: 'hit', path: hit.path, title: hit.title, snippet: hit.snippet }));

    const matchingActions = actions
      .filter((action) => action.label.toLowerCase().includes(trimmed.toLowerCase()))
      .map((action): Row => ({ kind: 'action', action }));

    return [...quick, ...hits, ...matchingActions];
  }, [query, search, actions]);

  useEffect(() => setActive(0), [query]);

  /**
   * Focus is taken and given back here, in the ref callback, rather than in an
   * effect. Effects run after paint: ⌘K is followed immediately by typing, and
   * a browser run typed "parser" into a palette that had not been focused yet
   * and got "rser". A ref callback runs during the commit, and its null call
   * runs on unmount even when the component never lived long enough for its
   * effects to fire.
   *
   * Stable identity via useCallback, so Preact invokes it on mount and unmount
   * only, not on every render.
   */
  const attachInput = useCallback((element: HTMLInputElement | null) => {
    if (element) {
      input.current = element;
      returnTo.current = document.activeElement;
      element.focus();
      return;
    }
    input.current = null;
    const target = returnTo.current;
    returnTo.current = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }, []);

  // Escape closes from anywhere, not only while the input has focus.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  function choose(row: Row | undefined) {
    if (!row) return;
    onClose();
    if (row.kind === 'action') row.action.run();
    else if (row.kind === 'note') onOpenNote(row.note.path);
    else onOpenNote(row.path);
  }

  return (
    <div class="backdrop palette-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          class="palette-input"
          ref={attachInput}
          value={query}
          placeholder="Search notes, or > for commands"
          aria-label="Search notes or run a command"
          aria-controls="palette-results"
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, rows.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(rows[active]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />

        <ul class="palette-results" id="palette-results" role="listbox">
          {rows.length === 0 && <li class="palette-empty">Nothing matches.</li>}
          {rows.map((row, index) => (
            <li key={rowKey(row)}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                class={`palette-row${index === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                {row.kind === 'action' ? (
                  <>
                    <span class="palette-label">{row.action.label}</span>
                    {row.action.hint && <span class="palette-hint">{row.action.hint}</span>}
                  </>
                ) : row.kind === 'note' ? (
                  <>
                    <span class="palette-label">
                      {row.note.title}
                      {row.note.encrypted && <span class="badge">enc</span>}
                    </span>
                    <span class="palette-hint">{row.note.path}</span>
                  </>
                ) : (
                  <>
                    <span class="palette-label">{row.title}</span>
                    <span class="palette-snippet">{row.snippet}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function rowKey(row: Row): string {
  if (row.kind === 'action') return `action:${row.action.id}`;
  if (row.kind === 'note') return `note:${row.note.path}`;
  return `hit:${row.path}`;
}
