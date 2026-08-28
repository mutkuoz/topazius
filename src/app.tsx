import type { IDBPDatabase } from 'idb';
import type { ComponentType } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { type AppConfig, type TopaziusDB, openVaultDB, readConfig } from './lib/db';
import { type Session, createSession } from './lib/session';
import { Lock } from './ui/Lock';
import { Setup } from './ui/Setup';
import type { UnlockedProps } from './unlocked';
import './ui/forms.css';

export interface AppProps {
  db: IDBPDatabase<TopaziusDB>;
}

export function App({ db: initialDb }: AppProps) {
  const [, forceRender] = useState(0);

  const [db, setDb] = useState<IDBPDatabase<TopaziusDB>>(initialDb);
  const [session, setSession] = useState<Session>(() => createSession({ db: initialDb }));
  const [config, setConfig] = useState<AppConfig | undefined>();
  const [notice, setNotice] = useState('');
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

  const state = session.state();

  // The editor half of the app is loaded on demand (see unlocked.tsx): it is
  // most of the bytes, and none of them are needed to render setup or the
  // lock screen. Kept in state rather than fetched per render so a re-render
  // during load does not start a second import.
  const [Unlocked, setUnlocked] = useState<ComponentType<UnlockedProps> | null>(null);

  useEffect(() => {
    if (state !== 'unlocked' || Unlocked !== null) return;
    let cancelled = false;
    void import('./unlocked')
      .then((module) => {
        if (!cancelled) setUnlocked(() => module.UnlockedApp);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFatal(
            error instanceof Error
              ? `Could not load the editor: ${error.message}`
              : 'Could not load the editor.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [state, Unlocked]);

  const onChange = useCallback(() => forceRender((n) => n + 1), []);

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
      setConfig(undefined);
      setNotice('');
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

  if (state === 'loading') {
    return <p class="hint">Loading...</p>;
  }

  if (state === 'empty') {
    return <Setup db={db} session={session} onDone={() => void readConfig(db).then(setConfig)} />;
  }

  if (state === 'locked') {
    return (
      <Lock
        session={session}
        config={config}
        notice={notice}
        onUnlocked={() => void readConfig(db).then(setConfig)}
        onForgot={() => void resetVault()}
      />
    );
  }

  if (!config || !Unlocked) {
    return <p class="hint">Loading...</p>;
  }

  return (
    <Unlocked
      db={db}
      session={session}
      config={config}
      onChange={onChange}
      onNotice={setNotice}
      onLock={(vault) => {
        // Whatever is still in the debounce window goes out before the key
        // disappears. The queue survives a lock either way, but a note that
        // was one keystroke from being committed should not have to wait for
        // the next unlock.
        void vault.flush().finally(() => session.lock());
        setNotice('');
      }}
    />
  );
}
