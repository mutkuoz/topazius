import { useEffect, useRef, useState } from 'preact/hooks';
import { type EditorHandle, createEditor } from '../editor/setup';
import './editor.css';

/** Keystroke to local storage, per spec §3.2. Typing never waits on this. */
export const SAVE_DEBOUNCE_MS = 400;

export interface EditorProps {
  path: string;
  /** The note's text as last read from the vault. */
  text: string;
  livePreview: boolean;
  readOnly?: boolean;
  /**
   * Receives the path as well as the text. A note switch can land between an
   * edit and the end of its debounce, and the pending text belongs to the note
   * it was typed into - never to whichever note is open when the timer fires.
   */
  onChange: (text: string, path: string) => void;
  /** ⌘S: commit now rather than at the end of the debounce. */
  onSaveNow: () => void;
  onFiles: (files: File[]) => void;
}

/**
 * CodeMirror, wrapped just thinly enough to be a component. The view is created
 * once and kept: recreating it on every render would lose the cursor, the
 * undo history, and the scroll position.
 */
export function Editor({ path, text, livePreview, readOnly, onChange, onSaveNow, onFiles }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // Latest callbacks, read at event time: the editor is built once, so
  // capturing this render's closures inside it would freeze them.
  const callbacks = useRef({ onChange, onSaveNow, onFiles });
  callbacks.current = { onChange, onSaveNow, onFiles };

  /** Flush the debounced edit for the note it was typed into. */
  function flushPending(notePath: string) {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current !== null) {
      callbacks.current.onChange(pending.current, notePath);
      pending.current = null;
    }
  }

  useEffect(() => {
    if (!host.current) return;
    const notePath = path;

    let created: EditorHandle;
    try {
      created = createEditor(
        host.current,
        text,
        {
          onChange: (value) => {
            pending.current = value;
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              const next = pending.current;
              pending.current = null;
              if (next !== null) callbacks.current.onChange(next, notePath);
            }, SAVE_DEBOUNCE_MS);
          },
          onSave: () => {
            flushPending(notePath);
            callbacks.current.onSaveNow();
          },
          onFiles: (files) => {
            const images = files.filter((file) => file.type.startsWith('image/'));
            if (images.length === 0) return false;
            callbacks.current.onFiles(images);
            return true;
          },
        },
        { livePreview, readOnly },
      );
    } catch (error) {
      // A browser too old for CodeMirror should say so rather than render a
      // blank pane over the user's notes.
      setFailed(error instanceof Error ? error.message : 'The editor could not start.');
      return;
    }

    handle.current = created;
    return () => {
      // An edit still inside the debounce must not be lost to a note switch.
      flushPending(notePath);
      created.destroy();
      handle.current = null;
    };
    // Deliberately built once per note: `text` is applied through setDoc below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // A note switch, or an external change (a conflict resolution, a reload).
  useEffect(() => {
    handle.current?.setDoc(text);
  }, [text]);

  useEffect(() => {
    handle.current?.setLivePreview(livePreview);
  }, [livePreview]);

  if (failed) {
    return (
      <p class="alert" role="alert">
        {failed}
      </p>
    );
  }

  return <div class="editor" ref={host} data-path={path} />;
}
