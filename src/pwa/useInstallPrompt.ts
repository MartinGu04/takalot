// Captures the browser's native PWA install prompt (Chromium's
// `beforeinstallprompt`) and tracks live standalone/installed state, for
// AVARIA's own onboarding UI to drive -- see onboarding/OnboardingModal.tsx.
// Mounted once, near the app root (so the event is captured as early as
// possible, whether or not the onboarding UI happens to be showing yet --
// the event fires once per page load and is lost if nothing was listening),
// exactly like usePwaUpdate's registration.
//
// `beforeinstallprompt` never fires on iOS (there is no programmatic
// install there -- see the onboarding UI's separate instructional copy)
// or on browsers that don't support it at all (desktop Safari, Firefox);
// `canPromptInstall` simply stays false in both cases, which
// determineOnboardingStep already treats as "nothing actionable here",
// never as an error.
import { useCallback, useEffect, useState } from 'react';
import { isStandaloneDisplayMode } from '../push/pushCapabilities';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallPromptState {
  /** Whether AVARIA is currently running standalone/installed on this device. */
  installed: boolean;
  /** Whether the browser has offered a native install prompt this page
   *  load, not yet consumed. */
  canPromptInstall: boolean;
  /**
   * Invokes the browser's native install prompt -- must only be called
   * from a direct user gesture (a click handler), matching the same
   * discipline usePushSubscription.enable() already requires for
   * Notification.requestPermission(). Resolves 'unavailable' (never
   * throws) if no prompt is currently captured.
   */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): InstallPromptState {
  const [installed, setInstalled] = useState(() => isStandaloneDisplayMode());
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Nothing left to capture or listen for once already installed.
    if (installed) return;
    const onBeforeInstallPrompt = (event: Event) => {
      // Prevents the browser's own default mini-infobar so AVARIA's CTA is
      // the only install entry point the user sees -- invoked later, only
      // in response to that CTA's click (see promptInstall below).
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    // A install can also complete without an 'appinstalled' event reaching
    // this listener in every browser -- the standard display-mode media
    // query is the more portable live signal, kept in sync alongside it.
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
    const onDisplayModeChange = () => setInstalled(isStandaloneDisplayMode());
    mql?.addEventListener('change', onDisplayModeChange);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      mql?.removeEventListener('change', onDisplayModeChange);
    };
  }, [installed]);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredEvent) return 'unavailable';
    await deferredEvent.prompt();
    const choice = await deferredEvent.userChoice;
    // A captured prompt event can only be used once, accepted or not.
    setDeferredEvent(null);
    return choice.outcome;
  }, [deferredEvent]);

  return { installed, canPromptInstall: deferredEvent !== null, promptInstall };
}
