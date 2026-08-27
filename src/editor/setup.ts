import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { continueList, insertAtCursor, toggleBold, toggleItalic } from './commands';
import { livePreview } from './live-preview';

/**
 * The CodeMirror instance (spec §8.1). The document text is the single source
 * of truth: nothing is parsed into an intermediate model and re-serialized, so
 * a note the user only opened round-trips byte-identically.
 */

/** Marks a transaction as "not the user typing" - a note switch, a reload. */
export const EXTERNAL = Annotation.define<boolean>();

export interface EditorHandle {
  view: EditorView;
  /** Replace the document without letting the change look like a user edit. */
  setDoc(text: string): void;
  setLivePreview(enabled: boolean): void;
  insert(text: string): void;
  focus(): void;
  destroy(): void;
}

export interface EditorCallbacks {
  onChange(text: string): void;
  /** ⌘S / Ctrl-S. */
  onSave(): void;
  /** Files pasted or dropped into the editor; return true to swallow the event. */
  onFiles(files: File[]): boolean;
}

const highlight = HighlightStyle.define([
  { tag: tags.link, class: 'cm-md-url' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: tags.keyword, class: 'cm-md-keyword' },
  { tag: tags.comment, class: 'cm-md-comment' },
  { tag: tags.string, class: 'cm-md-string' },
]);

/** Tab indents a list rather than escaping the editor, but never traps focus. */
const tabKeymap = [
  { key: 'Tab', run: indentMore, shift: indentLess },
  { key: 'Enter', run: continueList },
];

function fileList(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function createEditor(
  parent: HTMLElement,
  doc: string,
  callbacks: EditorCallbacks,
  options: { livePreview?: boolean; readOnly?: boolean } = {},
): EditorHandle {
  const preview = new Compartment();
  const editable = new Compartment();

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    indentUnit.of('  '),
    closeBrackets(),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(highlight),
    placeholder('Write…'),
    keymap.of([
      { key: 'Mod-s', run: () => (callbacks.onSave(), true), preventDefault: true },
      { key: 'Mod-b', run: toggleBold, preventDefault: true },
      { key: 'Mod-i', run: toggleItalic, preventDefault: true },
      ...tabKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),
    preview.of(options.livePreview === false ? [] : livePreview()),
    editable.of(EditorState.readOnly.of(options.readOnly === true)),
    EditorView.domEventHandlers({
      paste(event) {
        const files = fileList(event.clipboardData);
        if (files.length === 0) return false;
        if (!callbacks.onFiles(files)) return false;
        event.preventDefault();
        return true;
      },
      drop(event) {
        const files = fileList(event.dataTransfer);
        if (files.length === 0) return false;
        if (!callbacks.onFiles(files)) return false;
        event.preventDefault();
        return true;
      },
    }),
    EditorView.updateListener.of((update) => {
      // `docChanged` covers programmatic changes too; setDoc() below marks its
      // own transaction so the listener can tell them apart and not report a
      // note switch as an edit the user made.
      if (!update.docChanged) return;
      if (update.transactions.some((transaction) => transaction.annotation(EXTERNAL))) return;
      callbacks.onChange(update.state.doc.toString());
    }),
  ];

  const view = new EditorView({ parent, doc, extensions });

  return {
    view,

    setDoc(text) {
      if (text === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: EXTERNAL.of(true),
        selection: { anchor: 0 },
      });
    },

    setLivePreview(enabled) {
      view.dispatch({ effects: preview.reconfigure(enabled ? livePreview() : []) });
    },

    insert(text) {
      insertAtCursor(text)(view);
    },

    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
