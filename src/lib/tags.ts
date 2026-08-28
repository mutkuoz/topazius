import { parseNote } from './frontmatter';
import { maskCode, maskHeadings } from './mdscan';

/**
 * An inline tag (spec §4.2): `#` immediately followed by a letter, then
 * letters, digits, `-`, `_` or `/` (nested tags). Not preceded by a word
 * character, so `a#b` and `#123` are not tags.
 */
const INLINE_TAG = /(^|[^\w&#])#([A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)*)/g;

export function inlineTags(body: string): string[] {
  const text = maskHeadings(maskCode(body));
  const found: string[] = [];
  for (const match of text.matchAll(INLINE_TAG)) {
    // A trailing `-` or `/` is punctuation the user typed after the tag,
    // not part of its name.
    const tag = (match[2] ?? '').replace(/[-/]+$/, '');
    if (tag) found.push(tag);
  }
  return found;
}

/**
 * Every tag on a note: the frontmatter list and the inline `#tags` in the body,
 * unioned and de-duplicated case-insensitively, first spelling wins (spec §4.2).
 */
export function noteTags(source: string): string[] {
  const parsed = parseNote(source);
  const seen = new Map<string, string>();
  for (const tag of [...parsed.fields.tags, ...inlineTags(parsed.body)]) {
    const trimmed = tag.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
  }
  return [...seen.values()];
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Vault-wide tag counts, most used first, then alphabetical. */
export function tagCounts(notes: Iterable<{ tags: string[] }>): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const note of notes) {
    for (const tag of new Set(note.tags.map((t) => t.toLowerCase()))) {
      const existing = counts.get(tag);
      if (existing) existing.count++;
      else counts.set(tag, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
