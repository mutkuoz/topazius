import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { type AppConfig, type TopaziusDB, openVaultDB, readConfig } from './lib/db';
import { GitHubError, createClient } from './lib/github';
import { type Session, createSession } from './lib/session';
import { loadVault, readNoteText } from './lib/sync';
import { Lock } from './ui/Lock';
import { NoteView } from './ui/NoteView';
import { Setup } from './ui/Setup';
import { Shell } from './ui/Shell';
import { Tree } from './ui/Tree';
import './ui/forms.css';

export interface AppProps {
  db: IDBPDatabase<TopaziusDB>;
}

export function App({ db: initialDb }: AppProps) {
  const [, forceRender] = useState(0);

  const [db, setDb] = useState<IDBPDatabase<TopaziusDB>>(initialDb);
  const [session, setSession] = useState<Session>(() => createSession({ db: initialDb }));
  const [config, setConfig] = useState<AppConfig | undefined>();
  const [paths, setPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    void readConfig(db).then(setConfig);
  }, [db]);

  // session.onChange() replays the current state immediately on subscribe,
  // so this can be a plain effect: it cannot miss a transition that already
  // happened before it ran (e.g. the constructor's readSecret() probe
  // resolving before this effect gets a chance to subscribe).
  useEffect(() => session.onChange(() => forceRender((n) => n + 1)), [session]);

  // Any interaction defers the idle lock.
  useEffect(() => {
    const touch = () => session.touch();
    const events = ['pointerdown', 'keydown'] as const;
    for (const event of events) window.addEventListener(event, touch, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, touch);
    };
  }, [session]);

  // Spec §5.3: lock once the tab has been hidden for five minutes. The
  // setTimeout below is the prompt path while the tab stays hidden, but a
  // frozen mobile tab, bfcache, or laptop sleep can starve it entirely - the
  // wall clock keeps moving but nothing runs to fire it. hiddenSince is the
  // safety net: on return to visible, if five minutes have really elapsed
  // (checked against Date.now(), not the timer having fired), lock anyway.
  useEffect(() => {
    let hiddenSince: number | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

    function onVisibilityChange() {
      if (hiddenTimer !== null) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }

      if (document.hidden) {
        hiddenSince = Date.now();
        hiddenTimer = setTimeout(() => session.lock(), 5 * 60_000);
        return;
      }

      if (hiddenSince !== null && Date.now() - hiddenSince >= 5 * 60_000) {
        session.lock();
      }
      hiddenSince = null;
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [session]);

  const load = useCallback(async () => {
    const current = await readConfig(db);
    if (!current) return;
    setConfig(current);
    setStatus('Loading...');
    try {
      const gh = createClient({
        token: () => session.getToken(),
        owner: current.owner,
        repo: current.repo,
      });
      const { paths, failures } = await loadVault({
        gh,
        db,
        key: session.getKey(),
        branch: current.branch,
        onProgress: (p) => setStatus(`Loading ${p.fetched}/${p.total}...`),
      });
      setPaths(paths);
      setStatus(
        failures.length > 0
          ? `${paths.length} notes (${failures.length} did not load)`
          : `${paths.length} notes`,
      );
    } catch (error) {
      // Spec §7.2: a 401 means the token is expired or revoked. Lock, so the
      // user is sent back through unlock rather than staring at a dead vault.
      if (error instanceof GitHubError && error.status === 401) {
        session.lock();
        setStatus('GitHub rejected your token. It may be expired or revoked.');
        return;
      }
      setStatus(error instanceof Error ? error.message : 'Could not load the vault.');
    }
  }, [db, session]);

  // The derived key must never be threaded through the component tree: this
  // closure reads it from the session at call time, so NoteView never holds a
  // reference to it and a locked session throws instead of handing out a
  // stale key. Memoised so its identity is stable across renders - NoteView's
  // effect depends on it, and a fresh function every render would re-run that
  // effect forever.
  const readNote = useCallback((path: string) => readNoteText(db, session.getKey(), path), [db, session]);

  // session.logout() closes deps.db and destroys the database, so both the
  // session and the db handle it was built with are dead once it resolves.
  // Recovering means opening a fresh handle and building a fresh session
  // around it, then clearing everything derived from the destroyed vault.
  // Every step here can reject (a second open tab, storage disabled mid-
  // session, a quota refusal on the fresh open); onForgot's caller ignores
  // this promise (`void resetVault()`), so an uncaught rejection would be
  // silent - the "I forgot my passphrase" recovery path dead-ending with no
  // feedback at all.
  const resetVault = useCallback(async () => {
    try {
      await session.logout();
      const freshDb = await openVaultDB();
      const freshSession = createSession({ db: freshDb });
      setDb(freshDb);
      setSession(freshSession);
      setPaths([]);
      setSelected(null);
      setConfig(undefined);
      setStatus('');
    } catch (error) {
      setFatal(error instanceof Error ? error.message : 'Could not reset the vault.');
    }
  }, [session]);

  if (fatal) {
    return (
      <div class="panel">
        <h1>Something went wrong</h1>
        <p class="alert" role="alert">
          {fatal}
        </p>
      </div>
    );
  }

  const state = session.state();

  if (state === 'loading') {
    return <p class="hint">Loading...</p>;
  }

  if (state === 'empty') {
    return <Setup db={db} session={session} onDone={() => void load()} />;
  }

  if (state === 'locked') {
    return (
      <Lock
        session={session}
        config={config}
        notice={status}
        onUnlocked={() => void load()}
        onForgot={() => void resetVault()}
      />
    );
  }

  return (
    <Shell
      status={status}
      onLock={() => session.lock()}
      sidebar={<Tree paths={paths} selected={selected} onSelect={setSelected} />}
      main={<NoteView readNote={readNote} path={selected} />}
    />
  );
}
