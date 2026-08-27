import { useEffect, useState } from 'preact/hooks';

/** The event Chromium fires when the app meets its installability criteria. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * "Install to home screen" (spec §11.4).
 *
 * Chromium hands the app the prompt and expects it to be offered from a real
 * user gesture; Safari and Firefox have no such event and install from their
 * own share menu, so this button simply never appears there - which is the
 * correct outcome, not a gap to paper over with instructions nobody reads.
 */
export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    function onPrompt(event: Event) {
      // Without this the browser shows its own mini-infobar instead.
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    }
    function onInstalled() {
      setPrompt(null);
    }

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!prompt) return null;

  return (
    <button
      type="button"
      class="secondary"
      onClick={() => {
        void prompt.prompt().then(() => prompt.userChoice.then(() => setPrompt(null)));
      }}
    >
      Install
    </button>
  );
}
