import type { IDBPDatabase } from 'idb';
import { useEffect, useMemo } from 'preact/hooks';
import type { AppConfig, TopaziusDB } from './lib/db';
import type { Session } from './lib/session';
import { type Vault, createVault } from './lib/vault';
import { Workspace } from './ui/Workspace';

export interface UnlockedProps {
  db: IDBPDatabase<TopaziusDB>;
  session: Session;
  config: AppConfig;
  onChange: () => void;
  /** Carries the 401 message onto the lock screen the vault is about to cause. */
  onNotice: (message: string) => void;
  onLock: (vault: Vault) => void;
}

/**
 * Everything behind the lock screen, in one module so it can be loaded on
 * demand.
 *
 * This is the whole reason for the split: CodeMirror, markdown-it, DOMPurify
 * and MiniSearch are most of the bytes this app ships, and none of them are
 * needed to render setup, or the lock screen, or to decide which of the two to
 * show. Keeping them out of the entry chunk is what holds the initial bundle
 * under spec §15's budget.
 */
export function UnlockedApp({ db, session, config, onChange, onNotice, onLock }: UnlockedProps) {
  /**
   * One vault per (db, session, config). It holds the write queue and the
   * in-memory index, so it must not be rebuilt on every render - and it must
   * not outlive a lock, because everything in it was derived from a key that
   * is gone by then.
   */
  const vault = useMemo(
    () => createVault({ db, session, config, onChange, onNotice }),
    [db, session, config, onChange, onNotice],
  );

  useEffect(() => {
    void vault.load();
    return () => vault.dispose();
  }, [vault]);

  return (
    <Workspace
      vault={vault}
      label={`${config.owner}/${config.repo}`}
      onLock={() => onLock(vault)}
    />
  );
}
