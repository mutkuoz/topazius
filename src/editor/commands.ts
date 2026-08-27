import { EditorSelection, type EditorState, type StateCommand, type Transaction } from '@codemirror/state';

/**
 * Editing commands that operate on the document text, so they can be tested
 * against an EditorState with no view attached.
 */

export interface Wrap {
  before: string;
  after: string;
}

const BOLD: Wrap = { before: '**', after: '**' };
const ITALIC: Wrap = { before: '*', after: '*' };

/**
 * Toggle a wrapping around the selection - or, with no selection, around the
 * word under the cursor. Toggling off restores the exact original text, so
 * bold-then-unbold is a no-op on the file (spec §8.1's byte-identical promise).
 */
export function toggleWrap(wrap: Wrap): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const { from, to } = range.empty ? wordAt(state, range.head) : range;
      const selected = state.sliceDoc(from, to);

      const alreadyInside =
        state.sliceDoc(Math.max(0, from - wrap.before.length), from) === wrap.before &&
        state.sliceDoc(to, Math.min(state.doc.length, to + wrap.after.length)) === wrap.after;

      if (selected.startsWith(wrap.before) && selected.endsWith(wrap.after) && selected.length > wrap.before.length + wrap.after.length) {
        const inner = selected.slice(wrap.before.length, selected.length - wrap.after.length);
        return {
          changes: { from, to, insert: inner },
          range: EditorSelection.range(from, from + inner.length),
        };
      }

      if (alreadyInside) {
        return {
          changes: [
            { from: from - wrap.before.length, to: from, insert: '' },
            { from: to, to: to + wrap.after.length, insert: '' },
          ],
          range: EditorSelection.range(from - wrap.before.length, to - wrap.before.length),
        };
      }

      return {
        changes: { from, to, insert: `${wrap.before}${selected}${wrap.after}` },
        range: EditorSelection.range(
          from + wrap.before.length,
          from + wrap.before.length + selected.length,
        ),
      };
    });

    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' } as Partial<Transaction>));
    return true;
  };
}

const WORD_CHAR = /[\w'-]/;

function wordAt(state: EditorState, position: number): { from: number; to: number } {
  const line = state.doc.lineAt(position);
  let from = position;
  let to = position;
  while (from > line.from && WORD_CHAR.test(state.sliceDoc(from - 1, from))) from--;
  while (to < line.to && WORD_CHAR.test(state.sliceDoc(to, to + 1))) to++;
  return { from, to };
}

export const toggleBold = toggleWrap(BOLD);
export const toggleItalic = toggleWrap(ITALIC);

/**
 * Insert text at the cursor, replacing any selection. Used by the image paste
 * path and by the palette's "insert link" action.
 */
export function insertAtCursor(text: string): StateCommand {
  return ({ state, dispatch }) => {
    dispatch(
      state.update(state.replaceSelection(text), {
        scrollIntoView: true,
        userEvent: 'input.paste',
      } as Partial<Transaction>),
    );
    return true;
  };
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;

/**
 * Enter inside a list continues it, and Enter on an empty item ends the list
 * rather than adding another empty bullet - the behaviour every markdown
 * editor has and whose absence is immediately noticeable.
 */
export const continueList: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.head);
  const match = LIST_ITEM.exec(line.text);
  if (!match) return false;

  const [, indent = '', marker = '-', space = ' ', task, content = ''] = match;

  // An empty item: end the list instead of extending it.
  if (content.trim() === '') {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
        userEvent: 'input',
      }),
    );
    return true;
  }

  const next = /^\d/.test(marker)
    ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`
    : marker;
  // A task list continues as an unchecked task, never a copy of the tick.
  const insert = `\n${indent}${next}${space}${task ? '[ ] ' : ''}`;

  dispatch(
    state.update({
      changes: { from: range.head, insert },
      selection: { anchor: range.head + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};
