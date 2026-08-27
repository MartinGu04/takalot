// Combines this device's live install/notification state into the one
// decision AVARIA's onboarding UI needs (see determineOnboardingStep) plus
// the actions/dismissal it can drive. No new persisted "onboarding" state
// of its own beyond the dismissal cooldown -- everything else is read
// straight from usePushSubscription (already the single source of truth
// for Push readiness) and useInstallPrompt (live browser install state).
import { useSession } from '../auth/AuthContext';
import { usePushSubscription, type UsePushSubscriptionResult } from '../push/usePushSubscription';
import { isLikelyIOS } from '../push/pushCapabilities';
import { isPushWanted } from '../push/pushDevicePreference';
import { useInstallPrompt } from '../pwa/useInstallPrompt';
import { determineOnboardingStep, type OnboardingStep } from './onboardingStep';
import { dismissOnboarding, isOnboardingDismissed } from './onboardingDismissal';

export interface OnboardingState {
  step: OnboardingStep;
  installed: boolean;
  isIOS: boolean;
  canPromptInstall: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  /** The full usePushSubscription result -- the notifications step drives
   *  Push directly through it (enable/disable), never a second, parallel
   *  implementation. */
  push: UsePushSubscriptionResult;
  /** Whether the modal should be presented right now: something is still
   *  actionable AND the user has not recently postponed it on this device. */
  shouldShowModal: boolean;
  /** Records an "אחר כך" postponement for this user on this device. */
  dismiss: () => void;
}

export function useOnboardingState(): OnboardingState {
  const session = useSession();
  const push = usePushSubscription();
  const install = useInstallPrompt();
  const isIOS = isLikelyIOS();

  const step = determineOnboardingStep({
    installed: install.installed,
    isIOS,
    canPromptInstall: install.canPromptInstall,
    pushState: push.state,
    pushWanted: isPushWanted(session.userId),
  });

  return {
    step,
    installed: install.installed,
    isIOS,
    canPromptInstall: install.canPromptInstall,
    promptInstall: install.promptInstall,
    push,
    shouldShowModal: step !== 'done' && !isOnboardingDismissed(session.userId),
    dismiss: () => dismissOnboarding(session.userId),
  };
}
