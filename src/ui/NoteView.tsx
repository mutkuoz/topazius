import { useEffect, useState } from 'preact/hooks';
import { parseNote, resolveTitle } from '../lib/frontmatter';
import { isEncryptedPath } from '../lib/paths';

export interface NoteViewProps {
  readNote: (path: string) => Promise<string>;
  path: string | null;
}

/** Read-only for now; the CodeMirror editor arrives in plan 2. */
export function NoteView({ readNote, path }: NoteViewProps) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setText(null);
    setError(null);

    readNote(path)
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open that note.');
      });

    return () => {
      cancelled = true;
    };
  }, [readNote, path]);

  if (path === null) return <p class="hint">Select a note.</p>;
  if (error)
    return (
      <p class="alert" role="alert">
        {error}
      </p>
    );
  if (text === null) return <p class="hint">Opening...</p>;

  if (isEncryptedPath(path)) {
    return (
      <p class="hint">
        This note is encrypted. Opening sealed notes arrives with the encryption milestone.
      </p>
    );
  }

  const parsed = parseNote(text);
  return (
    <article>
      <h1>{resolveTitle(path, parsed)}</h1>
      <pre class="note-source">{parsed.body}</pre>
    </article>
  );
}
