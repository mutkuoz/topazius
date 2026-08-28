import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * Live preview (spec §8.1): the document stays plain markdown - nothing is
 * parsed into a model and re-serialized - and the *rendering* is decorated
 * instead. Headings scale, emphasis styles, code and quotes tint, and the
 * syntax markers dim until the cursor is on their line, where they return to
 * full opacity so editing them is never guesswork.
 *
 * This is a StateField rather than a ViewPlugin so it is a pure function of the
 * document and the selection, and can be tested without a DOM.
 */

const HEADING = /^ATXHeading([1-6])$/;

/** Node types whose whole range gets a style. */
const CONTENT_CLASS: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
  FencedCode: 'cm-md-block-code',
  CodeBlock: 'cm-md-block-code',
  Blockquote: 'cm-md-quote',
  Link: 'cm-md-link',
  URL: 'cm-md-url',
  ListMark: 'cm-md-list-mark',
  QuoteMark: 'cm-md-marker',
  TaskMarker: 'cm-md-task',
};

/** Node types that are punctuation: dimmed unless the cursor is on their line. */
const MARKER_TYPES = new Set([
  'EmphasisMark',
  'CodeMark',
  'HeaderMark',
  'LinkMark',
  'StrikethroughMark',
  'QuoteMark',
]);

const decorationFor = new Map<string, Decoration>();

function markFor(className: string): Decoration {
  let decoration = decorationFor.get(className);
  if (!decoration) {
    decoration = Decoration.mark({ class: className });
    decorationFor.set(className, decoration);
  }
  return decoration;
}

/** The lines the cursor (or any selection range) touches: markers there stay visible. */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let line = from; line <= to; line++) lines.add(line);
  }
  return lines;
}

export function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const active = activeLines(state);
  const tree = syntaxTree(state);

  // RangeSetBuilder requires strictly increasing `from`, and the syntax tree
  // hands nodes back in exactly that order - but a heading needs both a line
  // decoration and marks inside it, so ranges are gathered first and sorted.
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];

  tree.iterate({
    enter(node) {
      const heading = HEADING.exec(node.name);
      if (heading) {
        ranges.push({
          from: node.from,
          to: node.to,
          decoration: markFor(`cm-md-heading cm-md-h${heading[1]}`),
        });
        return;
      }

      const contentClass = CONTENT_CLASS[node.name];
      if (contentClass) {
        ranges.push({ from: node.from, to: node.to, decoration: markFor(contentClass) });
      }

      if (MARKER_TYPES.has(node.name)) {
        const line = state.doc.lineAt(node.from).number;
        ranges.push({
          from: node.from,
          to: node.to,
          decoration: markFor(active.has(line) ? 'cm-md-marker cm-md-marker-active' : 'cm-md-marker'),
        });
      }
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const range of ranges) {
    if (range.from === range.to) continue;
    builder.add(range.from, range.to, range.decoration);
  }
  return builder.finish();
}

export const livePreviewField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, transaction) {
    // Recomputed on any document or selection change: the "reveal the markers
    // on the cursor's line" behaviour is a function of the selection, so a
    // pure cursor move has to rebuild too.
    if (!transaction.docChanged && !transaction.selection) return value;
    return buildDecorations(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The live-preview extension, toggled by ui/Editor.tsx. */
export function livePreview(): Extension {
  return [livePreviewField];
}
