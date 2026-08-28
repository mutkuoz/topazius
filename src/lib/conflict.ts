/**
 * 409 handling (spec §7.3). Nothing here resolves anything on its own: silent
 * resolution is how notes get lost, so this module only *describes* the
 * disagreement and leaves the choice to the user.
 */

export interface Conflict {
  path: string;
  /** What this device has. */
  local: string;
  /** What GitHub has now. */
  remote: string;
  /** The sha any resolution must be written against. */
  remoteSha: string;
  /** True when the remote file is gone - deleted elsewhere while we edited. */
  remoteMissing: boolean;
}

export type ResolutionChoice =
  | { kind: 'mine' }
  | { kind: 'theirs' }
  | { kind: 'merged'; text: string };

export interface Resolution {
  /** The text to store locally, and (except for 'theirs') to upload. */
  text: string;
  /** The sha the upload must quote so GitHub accepts it. */
  sha: string;
  /** False for 'theirs': the remote already holds this content. */
  upload: boolean;
}

export function resolve(conflict: Conflict, choice: ResolutionChoice): Resolution {
  switch (choice.kind) {
    case 'mine':
      return { text: conflict.local, sha: conflict.remoteSha, upload: true };
    case 'theirs':
      return { text: conflict.remote, sha: conflict.remoteSha, upload: false };
    case 'merged':
      return { text: choice.text, sha: conflict.remoteSha, upload: true };
  }
}

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Longest-common-subsequence line diff, for showing *which* regions differ.
 * Only ever used for display - the app never merges automatically (§7.3).
 *
 * Quadratic in the number of lines, which is fine for one note but not for a
 * novel: above LINE_CAP lines the diff degrades to "these blocks differ"
 * rather than freezing the tab.
 */
const LINE_CAP = 2_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length > LINE_CAP || b.length > LINE_CAP) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'removed', text })),
      ...b.map((text): DiffLine => ({ kind: 'added', text })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'removed', text: a[i] as string });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j] as string });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] as string });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] as string });

  return out;
}

export function hasDifferences(diff: DiffLine[]): boolean {
  return diff.some((line) => line.kind !== 'same');
}

/** A one-line summary for the status chip: "3 added, 1 removed". */
export function summarise(diff: DiffLine[]): string {
  const added = diff.filter((line) => line.kind === 'added').length;
  const removed = diff.filter((line) => line.kind === 'removed').length;
  if (added === 0 && removed === 0) return 'identical';
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} line${added === 1 ? '' : 's'} added`);
  if (removed > 0) parts.push(`${removed} line${removed === 1 ? '' : 's'} removed`);
  return parts.join(', ');
}
