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

export interface AppProps {
  db: IDBPDatabase<TopaziusDB>;
}

export function App({ db: initialDb }: AppProps) {
  const [, forceRender] = useState(0);

  // createSession() starts an async readSecret() lookup immediately, and
  // that lookup can resolve - and call notify() - before a useEffect keyed on
  // `session` gets a chance to run and subscribe. When that happens the
  // notification is lost and the app is stuck rendering a stale state until
  // something else happens to trigger a re-render. Subscribing here, in the
  // same synchronous tick as construction, closes that window; every session
  // this component ever holds is built through this helper instead of a
  // deferred effect.
  const attach = useCallback((newSession: Session): Session => {
    newSession.onChange(() => forceRender((n) => n + 1));
    return newSession;
  }, []);

  const [db, setDb] = useState<IDBPDatabase<TopaziusDB>>(initialDb);
  const [session, setSession] = useState<Session>(() => attach(createSession({ db: initialDb })));
  const [config, setConfig] = useState<AppConfig | undefined>();
  const [paths, setPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void readConfig(db).then(setConfig);
  }, [db]);

  // Any interaction defers the idle lock.
  useEffect(() => {
    const touch = () => session.touch();
    const events = ['pointerdown', 'keydown'] as const;
    for (const event of events) window.addEventListener(event, touch, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, touch);
    };
  }, [session]);

  // Spec §5.3: lock once the tab has been hidden for five minutes.
  useEffect(() => {
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

    function onVisibilityChange() {
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      hiddenTimer = document.hidden ? setTimeout(() => session.lock(), 5 * 60_000) : null;
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
      const found = await loadVault({
        gh,
        db,
        key: session.getKey(),
        branch: current.branch,
        onProgress: (p) => setStatus(`Loading ${p.fetched}/${p.total}...`),
      });
      setPaths(found);
      setStatus(`${found.length} notes`);
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
  const resetVault = useCallback(async () => {
    await session.logout();
    const freshDb = await openVaultDB();
    const freshSession = attach(createSession({ db: freshDb }));
    setDb(freshDb);
    setSession(freshSession);
    setPaths([]);
    setSelected(null);
    setConfig(undefined);
    setStatus('');
  }, [session, attach]);

  const state = session.state();

  if (state === 'empty') {
    return <Setup db={db} session={session} onDone={() => void load()} />;
  }

  if (state === 'locked') {
    return (
      <Lock
        session={session}
        config={config}
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
