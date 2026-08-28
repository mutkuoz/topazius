import MiniSearch from 'minisearch';
import { parseNote, resolveTitle } from './frontmatter';
import { isEncryptedPath } from './paths';
import { noteTags } from './tags';

/** One note as the index and the UI see it. Built at unlock, never persisted (spec §6). */
export interface IndexedNote {
  path: string;
  title: string;
  tags: string[];
  body: string;
  encrypted: boolean;
}

export interface SearchHit {
  path: string;
  title: string;
  tags: string[];
  /** A one-line excerpt around the first match, or the note's opening line. */
  snippet: string;
  /** Character ranges within `snippet` that matched, for highlighting. */
  matches: Array<[number, number]>;
  score: number;
}

export function indexNote(path: string, source: string): IndexedNote {
  const parsed = parseNote(source);
  return {
    path,
    title: resolveTitle(path, parsed),
    tags: noteTags(source),
    body: parsed.body,
    encrypted: isEncryptedPath(path),
  };
}

const SNIPPET_RADIUS = 90;

/** Escape a user-typed term for use in a RegExp; search input is not a pattern. */
function escapeRe(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function snippetFor(note: IndexedNote, terms: string[]): string {
  const body = note.body.replace(/\s+/g, ' ').trim();
  if (terms.length === 0) return body.slice(0, SNIPPET_RADIUS * 2);

  const pattern = new RegExp(terms.map(escapeRe).join('|'), 'i');
  const hit = pattern.exec(body);
  if (!hit) return body.slice(0, SNIPPET_RADIUS * 2);

  const start = Math.max(0, hit.index - SNIPPET_RADIUS);
  const end = Math.min(body.length, hit.index + hit[0].length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

export function highlightRanges(snippet: string, terms: string[]): Array<[number, number]> {
  if (terms.length === 0) return [];
  const pattern = new RegExp(terms.map(escapeRe).join('|'), 'gi');
  const ranges: Array<[number, number]> = [];
  for (const match of snippet.matchAll(pattern)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export interface VaultSearch {
  /** Add or replace one note, so a save updates the index without a rebuild. */
  update(note: IndexedNote): void;
  remove(path: string): void;
  search(query: string, limit?: number): SearchHit[];
  /** Fuzzy path match for quick-open, ignoring note bodies entirely. */
  quickOpen(query: string, limit?: number): IndexedNote[];
  notes(): IndexedNote[];
  get(path: string): IndexedNote | undefined;
  size(): number;
}

/**
 * Subsequence match: "wsu" matches "work/standup". This is what makes
 * quick-open feel like an editor's, and it is deliberately not MiniSearch -
 * fuzzy *path* matching and full-text search are different jobs.
 */
export function subsequenceScore(candidate: string, query: string): number {
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  if (needle === '') return 0.001;

  let score = 0;
  let at = -1;
  let previous = -2;
  for (const char of needle) {
    at = haystack.indexOf(char, at + 1);
    if (at === -1) return 0;
    score += at === previous + 1 ? 2 : 1; // consecutive characters are a better match
    previous = at;
  }
  // Shorter candidates win ties, so `pizza.md` beats `pizza-variations.md`.
  return score / (1 + haystack.length / 100);
}

export function createSearch(initial: IndexedNote[] = []): VaultSearch {
  const notes = new Map<string, IndexedNote>();
  const engine = new MiniSearch<IndexedNote>({
    idField: 'path',
    fields: ['title', 'tags', 'body', 'path'],
    storeFields: ['path'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 4, tags: 3, path: 2 },
      combineWith: 'AND',
    },
  });

  function update(note: IndexedNote) {
    if (notes.has(note.path)) engine.discard(note.path);
    notes.set(note.path, note);
    engine.add(note);
  }

  for (const note of initial) update(note);

  return {
    update,

    remove(path) {
      if (!notes.delete(path)) return;
      engine.discard(path);
    },

    search(query, limit = 30) {
      const trimmed = query.trim();
      if (trimmed === '') return [];
      const terms = trimmed.split(/\s+/);
      return engine
        .search(trimmed)
        .slice(0, limit)
        .flatMap((result) => {
          const note = notes.get(String(result['id']));
          if (!note) return [];
          const snippet = snippetFor(note, [...terms, ...result.terms]);
          return [
            {
              path: note.path,
              title: note.title,
              tags: note.tags,
              snippet,
              matches: highlightRanges(snippet, [...terms, ...result.terms]),
              score: result.score,
            },
          ];
        });
    },

    quickOpen(query, limit = 20) {
      const trimmed = query.trim();
      const scored = [...notes.values()]
        .map((note) => ({
          note,
          score: Math.max(subsequenceScore(note.path, trimmed), subsequenceScore(note.title, trimmed)),
        }))
        .filter((entry) => entry.score > 0);
      scored.sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path));
      return scored.slice(0, limit).map((entry) => entry.note);
    },

    notes: () => [...notes.values()],
    get: (path) => notes.get(path),
    size: () => notes.size,
  };
}
