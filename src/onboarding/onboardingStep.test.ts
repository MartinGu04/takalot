import { describe, expect, it } from 'vitest';
import { determineOnboardingStep, type OnboardingStepInput } from './onboardingStep';

const BASE: OnboardingStepInput = {
  installed: false,
  isIOS: false,
  canPromptInstall: false,
  pushState: 'permission-default',
  pushWanted: false,
};

describe('determineOnboardingStep', () => {
  it('an already-installed PWA with Push already subscribed is done -- no onboarding at all', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: true, pushState: 'subscribed' }),
    ).toBe('done');
  });

  it('an uninstalled Android/Chrome device with a captured install prompt shows the install step', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: false, canPromptInstall: true }),
    ).toBe('install');
  });

  it('an uninstalled iPhone always shows the install step, even with no native prompt available', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: false, isIOS: true, canPromptInstall: false }),
    ).toBe('install');
  });

  it('a desktop browser with neither installed nor a native prompt available skips straight past install', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: false, isIOS: false, canPromptInstall: false, pushState: 'subscribed' }),
    ).toBe('done');
  });

  it('installed + notification permission never requested shows the notifications step', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: true, pushState: 'permission-default' }),
    ).toBe('notifications');
  });

  it('installed + notification-ready (subscribed) device is done', () => {
    expect(determineOnboardingStep({ ...BASE, installed: true, pushState: 'subscribed' })).toBe('done');
  });

  it('installed + notification permission denied shows the notifications step exactly once (not a loop) -- the step itself is stateless per call', () => {
    expect(determineOnboardingStep({ ...BASE, installed: true, pushState: 'permission-denied' })).toBe(
      'notifications',
    );
    // Calling it again with the exact same input is still 'notifications' --
    // it is usePushSubscription.enable() (never called automatically here)
    // that is responsible for not re-prompting, not this pure function.
    expect(determineOnboardingStep({ ...BASE, installed: true, pushState: 'permission-denied' })).toBe(
      'notifications',
    );
  });

  it('an intentional per-device notification opt-out (not-subscribed, not wanted) is respected -- treated as done, not broken', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: true, pushState: 'not-subscribed', pushWanted: false }),
    ).toBe('done');
  });

  it('a transient not-subscribed state for a device that DOES want push (about to auto-restore) is treated as done, not flashed as actionable', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: true, pushState: 'not-subscribed', pushWanted: true }),
    ).toBe('done');
  });

  it('unsupported push (no Push API at all) is done, not a blocking step', () => {
    expect(determineOnboardingStep({ ...BASE, installed: true, pushState: 'unsupported' })).toBe('done');
  });

  it('missing/invalid VAPID configuration is done, not a blocking step', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: true, pushState: 'configuration-unavailable' }),
    ).toBe('done');
  });

  it('a transient loading/error push state never resolves to an actionable step', () => {
    expect(determineOnboardingStep({ ...BASE, installed: true, pushState: 'loading' })).toBe('done');
    expect(determineOnboardingStep({ ...BASE, installed: true, pushState: 'error' })).toBe('done');
  });

  it('install always takes priority over notifications when both would otherwise be actionable', () => {
    expect(
      determineOnboardingStep({ ...BASE, installed: false, canPromptInstall: true, pushState: 'permission-default' }),
    ).toBe('install');
  });

  it('a new device for a previously-onboarded user is evaluated independently -- installed elsewhere never leaks in', () => {
    // Same user, brand-new phone: nothing here is true yet.
    expect(
      determineOnboardingStep({
        installed: false,
        isIOS: true,
        canPromptInstall: false,
        pushState: 'unsupported',
        pushWanted: true, // wanted on a DIFFERENT device -- irrelevant here
      }),
    ).toBe('install');
  });
});
