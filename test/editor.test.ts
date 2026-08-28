import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  continueList,
  insertCodeBlock,
  insertLink,
  insertRule,
  insertTable,
  insertWikilink,
  toggleBold,
  toggleBulletList,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleTaskList,
} from '../src/editor/commands';
import { activeLines, buildDecorations } from '../src/editor/live-preview';

/**
 * Commands and decorations are exercised against an EditorState with no view:
 * that is why they live in editor/commands.ts and editor/live-preview.ts
 * rather than inside the component.
 */
function stateFor(doc: string, selection?: { anchor: number; head?: number }): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
    ...(selection
      ? { selection: EditorSelection.single(selection.anchor, selection.head ?? selection.anchor) }
      : {}),
  });
}

/** Run a command and return the resulting document and selection. */
function run(state: EditorState, command: StateCommand) {
  let next = state;
  const handled = command({
    state,
    dispatch: (transaction) => {
      next = transaction.state;
    },
  });
  return { handled, doc: next.doc.toString(), selection: next.selection.main };
}

describe('bold and italic', () => {
  it('wraps a selection', () => {
    const state = stateFor('make this bold', { anchor: 10, head: 14 });
    expect(run(state, toggleBold).doc).toBe('make this **bold**');
  });

  it('wraps the word under the cursor when nothing is selected', () => {
    const state = stateFor('make this bold', { anchor: 12 });
    expect(run(state, toggleBold).doc).toBe('make this **bold**');
  });

  it('unwraps a selection that is already bold, byte for byte', () => {
    const original = 'make this bold';
    const bolded = run(stateFor(original, { anchor: 10, head: 14 }), toggleBold).doc;
    const unbolded = run(stateFor(bolded, { anchor: 10, head: 18 }), toggleBold).doc;
    expect(unbolded).toBe(original);
  });

  it('unwraps when the cursor is inside the markers rather than around them', () => {
    const state = stateFor('a **word** here', { anchor: 4, head: 8 });
    expect(run(state, toggleBold).doc).toBe('a word here');
  });

  it('leaves the selection on the text, not on the markers', () => {
    const { selection } = run(stateFor('bold', { anchor: 0, head: 4 }), toggleBold);
    expect([selection.from, selection.to]).toEqual([2, 6]);
  });

  it('italic uses single asterisks', () => {
    expect(run(stateFor('word', { anchor: 0, head: 4 }), toggleItalic).doc).toBe('*word*');
  });
});

describe('list continuation', () => {
  it('continues a bullet list', () => {
    const doc = '- one';
    expect(run(stateFor(doc, { anchor: doc.length }), continueList).doc).toBe('- one\n- ');
  });

  it('keeps the indentation of a nested item', () => {
    const doc = '  - one';
    expect(run(stateFor(doc, { anchor: doc.length }), continueList).doc).toBe('  - one\n  - ');
  });

  it('numbers the next item of an ordered list', () => {
    const doc = '3. three';
    expect(run(stateFor(doc, { anchor: doc.length }), continueList).doc).toBe('3. three\n4. ');
  });

  it('continues a task list unchecked', () => {
    const doc = '- [x] done';
    expect(run(stateFor(doc, { anchor: doc.length }), continueList).doc).toBe('- [x] done\n- [ ] ');
  });

  it('ends the list on an empty item instead of adding another bullet', () => {
    const doc = '- one\n- ';
    expect(run(stateFor(doc, { anchor: doc.length }), continueList).doc).toBe('- one\n');
  });

  it('declines outside a list, so Enter does its normal thing', () => {
    const doc = 'just a paragraph';
    expect(run(stateFor(doc, { anchor: doc.length }), continueList).handled).toBe(false);
  });
});

describe('the toolbar commands', () => {
  const line = (doc: string, at = doc.length) => stateFor(doc, { anchor: at });

  it('sets a heading, and clears it when pressed again', () => {
    expect(run(line('A title'), toggleHeading(1)).doc).toBe('# A title');
    expect(run(line('# A title'), toggleHeading(1)).doc).toBe('A title');
  });

  it('replaces one heading level with another rather than stacking them', () => {
    expect(run(line('# A title'), toggleHeading(3)).doc).toBe('### A title');
  });

  it('turns a list item into a heading without keeping the bullet', () => {
    expect(run(line('- an item'), toggleHeading(2)).doc).toBe('## an item');
  });

  it('applies to every line the selection touches', () => {
    const state = stateFor('one\ntwo\nthree', { anchor: 0, head: 13 });
    expect(run(state, toggleBulletList).doc).toBe('- one\n- two\n- three');
  });

  it('numbers an ordered list down the selection', () => {
    const state = stateFor('one\ntwo\nthree', { anchor: 0, head: 13 });
    expect(run(state, toggleOrderedList).doc).toBe('1. one\n2. two\n3. three');
  });

  it('toggles a task list on and off', () => {
    expect(run(line('do the thing'), toggleTaskList).doc).toBe('- [ ] do the thing');
    expect(run(line('- [x] done'), toggleTaskList).doc).toBe('done');
  });

  it('toggles a quote', () => {
    expect(run(line('quoted'), toggleQuote).doc).toBe('> quoted');
    expect(run(line('> quoted'), toggleQuote).doc).toBe('quoted');
  });

  it('wraps in strikethrough and inline code', () => {
    expect(run(stateFor('gone', { anchor: 0, head: 4 }), toggleStrikethrough).doc).toBe('~~gone~~');
    expect(run(stateFor('npm run dev', { anchor: 0, head: 11 }), toggleInlineCode).doc).toBe(
      '`npm run dev`',
    );
  });

  it('leaves the caret in the URL when the selection is the link text', () => {
    const { doc, selection } = run(stateFor('the docs', { anchor: 0, head: 8 }), insertLink);
    expect(doc).toBe('[the docs]()');
    expect(doc.slice(selection.head)).toBe(')');
  });

  it('leaves the caret in the text when the selection is a URL', () => {
    const url = 'https://example.com';
    const { doc, selection } = run(stateFor(url, { anchor: 0, head: url.length }), insertLink);
    expect(doc).toBe(`[](${url})`);
    expect(selection.head).toBe(1);
  });

  it('wraps a selection as a wikilink', () => {
    expect(run(stateFor('work/roadmap', { anchor: 0, head: 12 }), insertWikilink).doc).toBe(
      '[[work/roadmap]]',
    );
  });

  it('inserts a fenced code block around the selection', () => {
    expect(run(stateFor('npm test', { anchor: 0, head: 8 }), insertCodeBlock).doc).toBe(
      '```\nnpm test\n```\n',
    );
  });

  it('inserts a table with the alignment row markdown uses', () => {
    const { doc } = run(line(''), insertTable);
    expect(doc).toContain('| --- | --- |');
    expect(doc.split('\n')).toHaveLength(4);
  });

  it('inserts a divider on its own line', () => {
    expect(run(line('text'), insertRule).doc).toBe('text\n---\n');
  });

  it('declines a heading that would change nothing', () => {
    // mapLines returns false when the document would be identical, so the
    // editor can fall through to whatever else is bound to the key.
    expect(run(line(''), toggleQuote).handled).toBe(true);
  });
});

describe('live-preview decorations', () => {
  function classesIn(doc: string, selection?: { anchor: number }): string[] {
    const state = stateFor(doc, selection);
    const found: string[] = [];
    buildDecorations(state).between(0, state.doc.length, (_from, _to, decoration) => {
      const className = (decoration.spec as { class?: string }).class;
      if (className) found.push(className);
    });
    return found;
  }

  it('styles headings by level', () => {
    expect(classesIn('# Title')).toContain('cm-md-heading cm-md-h1');
    expect(classesIn('### Small')).toContain('cm-md-heading cm-md-h3');
  });

  it('styles emphasis, code, and quotes', () => {
    expect(classesIn('**bold**')).toContain('cm-md-strong');
    expect(classesIn('*em*')).toContain('cm-md-em');
    expect(classesIn('`code`')).toContain('cm-md-code');
    expect(classesIn('> quoted')).toContain('cm-md-quote');
  });

  it('dims the markers of a line the cursor is not on', () => {
    // Cursor parked on line 1; the emphasis markers are on line 3.
    const classes = classesIn('first line\n\n**bold**', { anchor: 0 });
    expect(classes).toContain('cm-md-marker');
    expect(classes).not.toContain('cm-md-marker cm-md-marker-active');
  });

  it('reveals the markers on the line the cursor is on', () => {
    const doc = 'first line\n\n**bold**';
    const classes = classesIn(doc, { anchor: doc.length });
    expect(classes).toContain('cm-md-marker cm-md-marker-active');
  });

  it('knows which lines the selection touches', () => {
    const state = stateFor('one\ntwo\nthree', { anchor: 2, head: 9 });
    expect([...activeLines(state)]).toEqual([1, 2, 3]);
  });

  it('accepts a document whose decorations nest and overlap', () => {
    // RangeSetBuilder throws unless ranges arrive sorted by start, and nested
    // markup (a marker inside emphasis inside a heading) is exactly where an
    // unsorted walk of the syntax tree would break the editor outright.
    const dense = '# A **bold** title\n\n> quoted `code` and *em*\n\n- [ ] task';
    expect(() => buildDecorations(stateFor(dense))).not.toThrow();
    expect(classesIn(dense)).toEqual(expect.arrayContaining(['cm-md-heading cm-md-h1', 'cm-md-strong']));
  });
});
