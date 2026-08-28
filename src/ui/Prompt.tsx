import { useState } from 'preact/hooks';
import { Dialog } from './Dialog';

export interface PromptProps {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  hint?: string;
  /** Return an error message to keep the dialog open, or null to accept. */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

/** One-field dialog: new note, rename, move. */
export function Prompt({
  title,
  label,
  initial = '',
  confirmLabel = 'OK',
  hint,
  validate,
  onSubmit,
  onCancel,
}: PromptProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    const problem = validate?.(value) ?? null;
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    try {
      await onSubmit(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={title} onClose={onCancel}>
      <form onSubmit={submit} class="stack">
        <label>
          {label}
          <input
            value={value}
            onInput={(event) => {
              setValue(event.currentTarget.value);
              setError(null);
            }}
            autocomplete="off"
            spellcheck={false}
            required
          />
        </label>
        {hint && <p class="hint">{hint}</p>}
        {error && (
          <p class="alert" role="alert">
            {error}
          </p>
        )}
        <div class="row">
          <button type="submit" disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
          <button type="button" class="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export interface ConfirmProps {
  title: string;
  body: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function Confirm({
  title,
  body,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title={title} onClose={onCancel}>
      <p>{body}</p>
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      <div class="row">
        <button
          type="button"
          class={destructive ? 'danger' : ''}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'That did not work.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
        <button type="button" class="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
