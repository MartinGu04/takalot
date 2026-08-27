import { beforeEach, describe, expect, it } from 'vitest';
import { dismissOnboarding, isOnboardingDismissed, ONBOARDING_DISMISS_COOLDOWN_MS } from './onboardingDismissal';

const USER_A = 'user-a';
const USER_B = 'user-b';

beforeEach(() => {
  localStorage.clear();
});

describe('onboardingDismissal', () => {
  it('is not dismissed before dismissOnboarding is ever called', () => {
    expect(isOnboardingDismissed(USER_A)).toBe(false);
  });

  it('is dismissed immediately after dismissOnboarding, within the cooldown window', () => {
    let now = 1_000_000;
    dismissOnboarding(USER_A, () => now);
    now += 1000;
    expect(isOnboardingDismissed(USER_A, () => now)).toBe(true);
  });

  it('stops being dismissed once the cooldown window elapses', () => {
    let now = 1_000_000;
    dismissOnboarding(USER_A, () => now);
    now += ONBOARDING_DISMISS_COOLDOWN_MS + 1;
    expect(isOnboardingDismissed(USER_A, () => now)).toBe(false);
  });

  it('is scoped per user -- dismissing for one user never affects another, even on the same device', () => {
    dismissOnboarding(USER_A);
    expect(isOnboardingDismissed(USER_B)).toBe(false);
    expect(isOnboardingDismissed(USER_A)).toBe(true);
  });

  it('treats a malformed stored value as not dismissed rather than throwing', () => {
    localStorage.setItem('takalot-onboarding-dismissed-until:user-a', 'not-a-number');
    expect(isOnboardingDismissed(USER_A)).toBe(false);
  });
});
