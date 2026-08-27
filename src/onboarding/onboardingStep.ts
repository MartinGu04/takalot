// Pure decision logic for AVARIA's first-time setup experience -- no DOM,
// no browser APIs, no React. Everything this needs is passed in, so the
// whole "which step should THIS device see right now" question is
// unit-testable without jsdom, a real Service Worker, or a real Push
// subscription.
//
// Deliberately NOT driven by a single global `onboarding_completed` flag:
// the same user may be fully set up on one device (desktop, installed,
// Push enabled) and completely unconfigured on another (a brand-new
// phone) -- see the module's own callers, which always derive `installed`
// and `pushState` from THIS device's live state, never from a database
// column. See useOnboardingState.ts.
import type { PushSubscriptionState } from '../push/usePushSubscription';

export type OnboardingStep = 'install' | 'notifications' | 'done';

export interface OnboardingStepInput {
  /** Whether AVARIA is currently running in standalone/installed mode on
   *  THIS device (see pushCapabilities.isStandaloneDisplayMode). */
  installed: boolean;
  /** Best-effort iOS/iPadOS Safari signal (pushCapabilities.isLikelyIOS) --
   *  iOS never exposes a native install prompt, so it needs its own
   *  instructional step instead of a button. */
  isIOS: boolean;
  /** Whether the browser has offered a native install prompt this session
   *  (`beforeinstallprompt` captured and not yet consumed) -- see
   *  useInstallPrompt. Always false on iOS and on browsers that never fire
   *  the event (e.g. desktop Safari, Firefox). */
  canPromptInstall: boolean;
  /** usePushSubscription's own state machine value for this device. */
  pushState: PushSubscriptionState;
  /** Whether THIS device previously had Push explicitly enabled (see
   *  push/pushDevicePreference.isPushWanted) -- the only way to tell
   *  "never asked" apart from "the user explicitly turned it off" when
   *  pushState is 'not-subscribed' (browser permission is 'granted' in
   *  both underlying cases; only the stored intent differs). */
  pushWanted: boolean;
}

/**
 * Install is actionable (and takes priority over notifications) whenever
 * the device is not already installed AND there is something concrete to
 * do about it right now: iOS always gets its instructional step (there is
 * no programmatic install), everyone else only when the browser has
 * actually offered a native prompt. A desktop browser that supports
 * neither (e.g. it never fired `beforeinstallprompt`) has nothing
 * actionable to show here -- installation stays an optional, silently
 * skipped recommendation rather than a step that blocks reaching
 * notifications (see case D in the onboarding spec: a desktop browser
 * without installation must never trap the user).
 */
function isInstallActionable(input: OnboardingStepInput): boolean {
  return !input.installed && (input.isIOS || input.canPromptInstall);
}

/**
 * Notifications is actionable only in the two states that have something
 * for the user to actually do: permission was never asked
 * ('permission-default', show the enable CTA) or it was denied at the
 * browser level ('permission-denied', show blocked guidance once -- see
 * usePushSubscription.enable, which already refuses to re-prompt on its
 * own). Every other state is either already resolved ('subscribed'), an
 * intentional opt-out worth respecting silently ('not-subscribed' with
 * pushWanted false -- see the module comment), not applicable on this
 * device/browser at all ('unsupported', 'configuration-unavailable'), or
 * transiently inconclusive ('loading', 'error', 'install-required' -- the
 * last of which the install branch above already owns when relevant) --
 * none of those should interrupt the user with a step.
 */
function isNotificationsActionable(input: OnboardingStepInput): boolean {
  if (input.pushState === 'permission-default') return true;
  if (input.pushState === 'permission-denied') return true;
  return false;
}

export function determineOnboardingStep(input: OnboardingStepInput): OnboardingStep {
  if (isInstallActionable(input)) return 'install';
  if (isNotificationsActionable(input)) return 'notifications';
  return 'done';
}
