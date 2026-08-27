import { noteStem } from './paths';

export interface NoteFields {
  title?: string;
  tags: string[];
  created?: string;
  updated?: string;
}

export interface ParsedNote {
  /** The frontmatter block verbatim, fences and trailing newline included. '' when absent. */
  fmBlock: string;
  /** Everything after the block, verbatim. */
  body: string;
  fields: NoteFields;
}

const SCALAR_KEYS = ['title', 'created', 'updated'] as const;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted?.[2] ?? trimmed;
}

/**
 * Split a note into its frontmatter block and body without reformatting either.
 * Keeping fmBlock as verbatim text is what makes serializeNote byte-exact.
 */
export function parseNote(source: string): ParsedNote {
  const empty: ParsedNote = { fmBlock: '', body: source, fields: { tags: [] } };

  const open = /^---\r?\n/.exec(source);
  if (!open) return empty;

  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(source.slice(open[0].length));
  if (!close) return empty;

  const bodyStart = open[0].length + close.index + close[0].length;
  const fmBlock = source.slice(0, bodyStart);
  const inner = source.slice(open[0].length, open[0].length + close.index);

  return { fmBlock, body: source.slice(bodyStart), fields: readFields(inner) };
}

function readFields(inner: string): NoteFields {
  const fields: NoteFields = { tags: [] };
  const lines = inner.split(/\r?\n/);

  lines.forEach((line, i) => {
    for (const key of SCALAR_KEYS) {
      if (line.startsWith(`${key}:`)) {
        fields[key] = unquote(line.slice(key.length + 1));
      }
    }

    if (!line.startsWith('tags:')) return;

    const rest = line.slice('tags:'.length).trim();
    if (rest.startsWith('[')) {
      fields.tags = rest
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(unquote)
        .filter(Boolean);
      return;
    }
    if (rest === '') {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s*-\s+(.*)$/.exec(lines[j] ?? '');
        if (!item) break;
        fields.tags.push(unquote(item[1] ?? ''));
      }
    }
  });

  return fields;
}

export function serializeNote(note: ParsedNote): string {
  return note.fmBlock + note.body;
}

function renderValue(key: keyof NoteFields, value: string | string[]): string {
  return key === 'tags' ? `tags: [${(value as string[]).join(', ')}]` : `${key}: ${value as string}`;
}

/**
 * Patch frontmatter line-wise. Lines the caller did not name are preserved
 * exactly, including comments, unknown keys, and their original order.
 */
export function patchFrontmatter(source: string, changes: Partial<NoteFields>): string {
  const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as Array<
    [keyof NoteFields, string | string[]]
  >;
  if (entries.length === 0) return source;

  const parsed = parseNote(source);

  if (parsed.fmBlock === '') {
    const block = entries.map(([k, v]) => renderValue(k, v)).join('\n');
    return `---\n${block}\n---\n${source}`;
  }

  const eol = parsed.fmBlock.includes('\r\n') ? '\r\n' : '\n';
  const lines = parsed.fmBlock.split(/\r?\n/);
  // Tracks the fence's *current* index as lines are spliced in and out
  // below - it must stay live, not be computed once, or a second inserted
  // key lands before the first (reversing multi-key appends) and a splice
  // can shift genuinely-existing lines out of a stale search window.
  let closingFence = lines.length - (lines.at(-1) === '' ? 2 : 1);

  for (const [key, value] of entries) {
    const rendered = renderValue(key, value);
    const at = lines.findIndex((line, i) => i > 0 && i < closingFence && line.startsWith(`${key}:`));

    if (at === -1) {
      lines.splice(closingFence, 0, rendered);
      closingFence++; // the fence, and everything at/after it, shifted down by one line
    } else {
      lines[at] = rendered;
      // A replaced inline `tags:` must not leave its old block-list items behind.
      if (key === 'tags') {
        let next = at + 1;
        while (next < lines.length && /^\s*-\s+/.test(lines[next] ?? '')) {
          lines.splice(next, 1);
          closingFence--; // removing a block-list line shifts the fence up by one
        }
      }
    }
  }

  return lines.join(eol) + parsed.body;
}

export function resolveTitle(path: string, parsed: ParsedNote): string {
  if (parsed.fields.title) return parsed.fields.title;
  const h1 = /^#[ \t]+(.+)$/m.exec(parsed.body);
  if (h1?.[1]) return h1[1].trim();
  return noteStem(path).split('/').at(-1) ?? path;
}
