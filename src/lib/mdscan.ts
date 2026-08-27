/**
 * Text-level scanning helpers shared by the tag and wikilink extractors.
 *
 * Both need "the prose parts of this note", and both must agree on what counts
 * as prose or a `#tag` inside a code fence would be a tag to one and not the
 * other. Masking replaces characters with spaces rather than deleting them, so
 * every offset in the masked copy still points at the same character of the
 * original - which is what lets links.ts report exact indices.
 */

const FENCE = /^([ \t]*)(```+|~~~+)(.*)$/;

/** Blank out fenced blocks, indented code blocks, and inline code spans. */
export function maskCode(source: string): string {
  const lines = source.split('\n');
  let fence: string | null = null;

  const masked = lines.map((line) => {
    const opener = FENCE.exec(line);

    if (fence !== null) {
      // Inside a fence: a closing marker of the same kind, at least as long.
      if (opener && opener[2]?.startsWith(fence[0] ?? '') && (opener[2]?.length ?? 0) >= fence.length) {
        fence = null;
      }
      return ' '.repeat(line.length);
    }

    if (opener?.[2]) {
      fence = opener[2];
      return ' '.repeat(line.length);
    }

    // An indented code block. Not perfectly CommonMark (a four-space indent
    // inside a list is a continuation, not code), but erring towards "not
    // prose" only ever costs a tag or a link the user can still type again.
    if (/^(?: {4}|\t)/.test(line)) return ' '.repeat(line.length);

    return line.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  });

  return masked.join('\n');
}

/** Blank out ATX and setext headings: a line-leading `#` is a heading, not a tag. */
export function maskHeadings(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s{0,3}#{1,6}(?:\s|$)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}
