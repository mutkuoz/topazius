import { maskCode } from './mdscan';
import { noteStem } from './paths';

/** `[[target]]`, `[[target|alias]]`. Targets never contain `|`, `[` or `]`. */
const WIKILINK = /\[\[([^\][|\n]+)(?:\|([^\][\n]*))?\]\]/g;

export interface WikiLink {
  /** The target exactly as written, trimmed. */
  target: string;
  /** What to display: the alias when given, otherwise the target. */
  label: string;
  /** Offset of the whole `[[...]]` in the source it was found in. */
  index: number;
  length: number;
}

export function parseWikilinks(body: string): WikiLink[] {
  const masked = maskCode(body);
  const links: WikiLink[] = [];
  for (const match of masked.matchAll(WIKILINK)) {
    const target = (match[1] ?? '').trim();
    if (!target) continue;
    links.push({
      target,
      label: (match[2] ?? '').trim() || target,
      index: match.index,
      length: match[0].length,
    });
  }
  return links;
}

/**
 * Resolve a wikilink target against the vault.
 *
 * Targets match on the *stem*, so `.md` and `.md.enc` are the same note and
 * toggling a note's encryption never breaks an inbound link (spec §9.5).
 * Order: exact stem, then unique basename. An ambiguous basename resolves to
 * nothing rather than to a guess.
 */
export function resolveLink(target: string, paths: Iterable<string>): string | null {
  const wanted = noteStem(target.replace(/^\/+/, '')).toLowerCase();
  const byBasename: string[] = [];

  for (const path of paths) {
    const stem = noteStem(path).toLowerCase();
    if (stem === wanted) return path;
    if ((stem.split('/').at(-1) ?? '') === wanted) byBasename.push(path);
  }

  return byBasename.length === 1 ? (byBasename[0] ?? null) : null;
}

export interface Backlink {
  /** The note containing the link. */
  from: string;
  label: string;
  /** A short excerpt of the line the link sits on, for context. */
  context: string;
}

function lineAround(body: string, index: number): string {
  const start = body.lastIndexOf('\n', index) + 1;
  const end = body.indexOf('\n', index);
  return body.slice(start, end === -1 ? undefined : end).trim();
}

/**
 * Build the whole backlink graph in one pass: for every note, which notes link
 * to it. Unresolved targets are collected separately so the UI can offer
 * one-click creation (spec §4.2).
 */
export interface LinkGraph {
  backlinks: Map<string, Backlink[]>;
  /** target → the notes that link to it, for targets that resolve to nothing. */
  missing: Map<string, string[]>;
}

/**
 * Replace one note's contribution to an existing graph, in place.
 *
 * Rebuilding the whole graph on every save would re-parse every note in the
 * vault behind each keystroke's debounce; this touches only the note that
 * changed. `paths` is the vault as it stands, for resolving this note's links.
 */
export function updateLinksFor(
  graph: LinkGraph,
  path: string,
  body: string,
  paths: Iterable<string>,
): void {
  for (const [target, list] of graph.backlinks) {
    const kept = list.filter((link) => link.from !== path);
    if (kept.length === list.length) continue;
    if (kept.length === 0) graph.backlinks.delete(target);
    else graph.backlinks.set(target, kept);
  }

  for (const [target, sources] of graph.missing) {
    const kept = sources.filter((source) => source !== path);
    if (kept.length === sources.length) continue;
    if (kept.length === 0) graph.missing.delete(target);
    else graph.missing.set(target, kept);
  }

  for (const link of parseWikilinks(body)) {
    const target = resolveLink(link.target, paths);
    if (!target) {
      const sources = graph.missing.get(link.target) ?? [];
      if (!sources.includes(path)) sources.push(path);
      graph.missing.set(link.target, sources);
      continue;
    }
    if (target === path) continue;
    const list = graph.backlinks.get(target) ?? [];
    list.push({ from: path, label: link.label, context: lineAround(body, link.index) });
    graph.backlinks.set(target, list);
  }
}

export function buildLinkGraph(notes: Array<{ path: string; body: string }>): LinkGraph {
  const paths = notes.map((note) => note.path);
  const backlinks = new Map<string, Backlink[]>();
  const missing = new Map<string, string[]>();

  for (const note of notes) {
    for (const link of parseWikilinks(note.body)) {
      const target = resolveLink(link.target, paths);
      if (!target) {
        const sources = missing.get(link.target) ?? [];
        if (!sources.includes(note.path)) sources.push(note.path);
        missing.set(link.target, sources);
        continue;
      }
      if (target === note.path) continue; // a note linking to itself is not a backlink
      const list = backlinks.get(target) ?? [];
      list.push({ from: note.path, label: link.label, context: lineAround(note.body, link.index) });
      backlinks.set(target, list);
    }
  }

  return { backlinks, missing };
}

/**
 * Rewrite `[[old]]` to `[[new]]` in a body when a note is renamed. Only links
 * that actually resolved to `from` are touched, and the alias is preserved.
 * Returns the body unchanged when there is nothing to do, so an untouched note
 * is never rewritten (and never committed).
 */
export function rewriteLinks(body: string, from: string, to: string, paths: Iterable<string>): string {
  const links = parseWikilinks(body);
  if (links.length === 0) return body;

  const stemTo = noteStem(to);
  const basename = stemTo.split('/').at(-1) ?? stemTo;
  // A `[[pizza]]` should stay `[[pizza]]` after a move - but only while that
  // basename is still unique in the vault. Where it is not, the full stem is
  // written instead, because resolveLink() answers null on an ambiguous
  // basename and the link would silently render as missing.
  const after = [...paths].filter((path) => path !== from).concat(to);
  const keepShort = resolveLink(basename, after) === to;

  let out = '';
  let cursor = 0;

  for (const link of links) {
    if (resolveLink(link.target, paths) !== from) continue;
    const alias = link.label === link.target ? '' : `|${link.label}`;
    const replacement = !link.target.includes('/') && keepShort ? basename : stemTo;
    out += body.slice(cursor, link.index) + `[[${replacement}${alias}]]`;
    cursor = link.index + link.length;
  }

  return cursor === 0 ? body : out + body.slice(cursor);
}
