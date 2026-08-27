import type { Backlink } from '../lib/links';
import type { TagCount } from '../lib/tags';
import type { SyncStatus } from '../lib/queue';

export interface TagBarProps {
  tags: TagCount[];
  selected: string | null;
  onSelect: (tag: string | null) => void;
}

/** The tag filter beneath the tree (spec §11.1). */
export function TagBar({ tags, selected, onSelect }: TagBarProps) {
  if (tags.length === 0) return null;

  return (
    <div class="tagbar" role="group" aria-label="Filter by tag">
      {selected && (
        <button type="button" class="tag-chip clear" onClick={() => onSelect(null)}>
          clear filter
        </button>
      )}
      {tags.map((tag) => (
        <button
          key={tag.tag}
          type="button"
          class={`tag-chip${selected === tag.tag ? ' selected' : ''}`}
          aria-pressed={selected === tag.tag}
          onClick={() => onSelect(selected === tag.tag ? null : tag.tag)}
        >
          #{tag.tag}
          <span class="tag-count">{tag.count}</span>
        </button>
      ))}
    </div>
  );
}

export interface BacklinksProps {
  backlinks: Backlink[];
  onOpen: (path: string) => void;
}

export function Backlinks({ backlinks, onOpen }: BacklinksProps) {
  return (
    <section class="backlinks" aria-label="Backlinks">
      <h2>Backlinks ({backlinks.length})</h2>
      {backlinks.length === 0 ? (
        <p class="hint">Nothing links here yet.</p>
      ) : (
        <ul>
          {backlinks.map((link) => (
            <li key={`${link.from}:${link.context}`}>
              <button type="button" class="linkish" onClick={() => onOpen(link.from)}>
                {link.from}
              </button>
              <p class="hint">{link.context}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface StatusChipProps {
  status: SyncStatus;
  pending: number;
  message: string;
  onRetry: () => void;
}

const LABEL: Record<SyncStatus, string> = {
  synced: 'Synced',
  saving: 'Saving…',
  offline: 'Offline',
  paused: 'Paused',
  conflict: 'Conflict',
  error: 'Error',
};

/** Spec §7.4's status chip: what the queue is doing, in two words. */
export function StatusChip({ status, pending, message, onRetry }: StatusChipProps) {
  const label = pending > 0 && status !== 'saving' ? `${LABEL[status]} — ${pending} pending` : LABEL[status];
  const retryable = status === 'offline' || status === 'error' || status === 'paused';

  return (
    <span class={`chip chip-${status}`} title={message} role="status">
      {label}
      {retryable && (
        <button type="button" class="chip-retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </span>
  );
}
