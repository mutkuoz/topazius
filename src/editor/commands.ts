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

/**
 * Line-wise transforms. A formatting toolbar needs to act on whole lines -
 * headings, quotes, lists - and on every line the selection touches, which is
 * a different shape from the wrapping commands above.
 */
function mapLines(transform: (line: string, index: number) => string): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);

    const lines: string[] = [];
    for (let number = first.number; number <= last.number; number++) {
      lines.push(state.doc.line(number).text);
    }

    const replacement = lines.map(transform).join('\n');
    if (replacement === lines.join('\n')) return false;

    dispatch(
      state.update({
        changes: { from: first.from, to: last.to, insert: replacement },
        // Keep the whole affected block selected, so pressing the same button
        // twice toggles it back rather than acting on a collapsed cursor.
        selection: EditorSelection.range(first.from, first.from + replacement.length),
        scrollIntoView: true,
        userEvent: 'input',
      }),
    );
    return true;
  };
}

const HEADING = /^(#{1,6})\s+/;
const QUOTE = /^>\s?/;
const BULLET = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/;
const ORDERED = /^\s*\d+[.)]\s+/;
const TASK = /^\s*[-*+]\s+\[[ xX]\]\s+/;

/** Strip whatever block marker a line already carries, leaving its text. */
function bareLine(line: string): string {
  return line.replace(HEADING, '').replace(TASK, '').replace(BULLET, '').replace(ORDERED, '').replace(QUOTE, '');
}

/**
 * Apply a heading level, or remove it when the line is already at that level -
 * so the same button both sets and clears, the way every editor's does.
 */
export function toggleHeading(level: 1 | 2 | 3 | 4 | 5 | 6): StateCommand {
  return mapLines((line) => {
    const marker = '#'.repeat(level);
    const current = HEADING.exec(line);
    if (current?.[1] === marker) return bareLine(line);
    const text = bareLine(line);
    return text === '' ? `${marker} ` : `${marker} ${text}`;
  });
}

export const toggleQuote: StateCommand = mapLines((line) =>
  QUOTE.test(line) ? line.replace(QUOTE, '') : `> ${line}`,
);

export const toggleBulletList: StateCommand = mapLines((line) =>
  BULLET.test(line) && !TASK.test(line) ? line.replace(BULLET, '') : `- ${bareLine(line)}`,
);

export const toggleOrderedList: StateCommand = (target) =>
  mapLines((line, index) =>
    ORDERED.test(line) ? line.replace(ORDERED, '') : `${index + 1}. ${bareLine(line)}`,
  )(target);

export const toggleTaskList: StateCommand = mapLines((line) =>
  TASK.test(line) ? line.replace(TASK, '') : `- [ ] ${bareLine(line)}`,
);

export const toggleStrikethrough = toggleWrap({ before: '~~', after: '~~' });
export const toggleInlineCode = toggleWrap({ before: '`', after: '`' });

const URL_LIKE = /^(https?:\/\/|mailto:)\S+$/i;

/**
 * `[text](url)`, with the caret left where the next thing to type goes: in the
 * URL when there is text to link, in the text when there is a URL to label.
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);

  const [text, url] = URL_LIKE.test(selected) ? ['', selected] : [selected, ''];
  const insert = `[${text}](${url})`;
  const caret = url === '' ? range.from + insert.length - 1 : range.from + 1;

  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: caret },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/** `[[note]]`, the link to another note in this vault. */
export const insertWikilink: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const insert = `[[${selected}]]`;

  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + 2 + selected.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/** Insert `block` on lines of its own, keeping the blank lines markdown needs. */
function insertBlock(build: (selected: string) => string, caretOffset: (selected: string) => number): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const selected = state.sliceDoc(range.from, range.to);
    const line = state.doc.lineAt(range.from);

    // A leading newline only when something is actually in the way: text
    // before the selection on this line. Replacing a whole line - the usual
    // case when text is selected - must not push a blank line above it.
    const ahead = line.text.slice(0, range.from - line.from);
    const before = ahead.trim() === '' ? '' : '\n';
    const body = build(selected);
    const insert = `${before}${body}\n`;

    dispatch(
      state.update({
        changes: { from: range.from, to: range.to, insert },
        selection: { anchor: range.from + before.length + caretOffset(selected) },
        scrollIntoView: true,
        userEvent: 'input',
      }),
    );
    return true;
  };
}

export const insertCodeBlock = insertBlock(
  (selected) => `\`\`\`\n${selected}\n\`\`\``,
  () => 4, // just past the opening fence, where the language goes
);

export const insertRule = insertBlock(() => '---', () => 3);

/**
 * A GFM table skeleton. The alignment row is where markdown expresses
 * alignment at all - `:---`, `:---:`, `---:` per column - so the comment in the
 * toolbar points here rather than offering a paragraph-alignment control
 * markdown cannot represent.
 */
export const insertTable = insertBlock(
  () => ['| Column | Column |', '| --- | --- |', '|  |  |'].join('\n'),
  () => 2,
);
