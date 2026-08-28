import { useState } from 'preact/hooks';
import type { Conflict, ResolutionChoice } from '../lib/conflict';
import { diffLines, summarise } from '../lib/conflict';
import { Dialog } from './Dialog';

export interface ConflictDialogProps {
  conflict: Conflict;
  onResolve: (choice: ResolutionChoice) => Promise<void>;
  onClose: () => void;
}

/**
 * Spec §7.3: local and remote side by side, changed regions highlighted, and
 * three explicit outcomes. Nothing is merged automatically - silent resolution
 * is how notes get lost.
 */
export function ConflictDialog({ conflict, onResolve, onClose }: ConflictDialogProps) {
  const [merged, setMerged] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diff = diffLines(conflict.remote, conflict.local);

  async function choose(choice: ResolutionChoice) {
    setBusy(true);
    setError(null);
    try {
      await onResolve(choice);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`"${conflict.path}" changed on GitHub`} onClose={onClose} wide insistent>
      <p class="hint">
        {conflict.remoteMissing
          ? 'This note no longer exists on GitHub. Keeping yours will create it again.'
          : `Your copy and GitHub's have both moved on — ${summarise(diff)} against the remote copy. Nothing has been overwritten.`}
      </p>

      {merged === null ? (
        <div class="diff" role="group" aria-label="Differences">
          <div class="diff-pane">
            <h3>On GitHub</h3>
            <pre>
              {diff
                .filter((line) => line.kind !== 'added')
                .map((line, index) => (
                  <div key={index} class={line.kind === 'removed' ? 'diff-removed' : ''}>
                    {line.text || ' '}
                  </div>
                ))}
            </pre>
          </div>
          <div class="diff-pane">
            <h3>Yours</h3>
            <pre>
              {diff
                .filter((line) => line.kind !== 'removed')
                .map((line, index) => (
                  <div key={index} class={line.kind === 'added' ? 'diff-added' : ''}>
                    {line.text || ' '}
                  </div>
                ))}
            </pre>
          </div>
        </div>
      ) : (
        <label class="merge">
          Merged text
          <textarea
            value={merged}
            rows={16}
            spellcheck={false}
            onInput={(event) => setMerged(event.currentTarget.value)}
          />
        </label>
      )}

      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}

      <div class="dialog-actions">
        {merged === null ? (
          <>
            <button type="button" disabled={busy} onClick={() => void choose({ kind: 'mine' })}>
              Keep mine
            </button>
            <button
              type="button"
              class="secondary"
              disabled={busy}
              onClick={() => void choose({ kind: 'theirs' })}
            >
              Keep theirs
            </button>
            <button
              type="button"
              class="secondary"
              disabled={busy || conflict.remoteMissing}
              onClick={() => setMerged(`${conflict.local}\n${conflict.remote}`)}
            >
              Merge by hand…
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void choose({ kind: 'merged', text: merged })}
            >
              Save merged
            </button>
            <button type="button" class="secondary" disabled={busy} onClick={() => setMerged(null)}>
              Back
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
