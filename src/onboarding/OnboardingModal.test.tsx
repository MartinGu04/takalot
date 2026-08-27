import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockUseOnboardingState, dismissSpy, enableSpy, promptInstallSpy } = vi.hoisted(() => ({
  mockUseOnboardingState: vi.fn(),
  dismissSpy: vi.fn(),
  enableSpy: vi.fn(),
  promptInstallSpy: vi.fn().mockResolvedValue('accepted'),
}));

vi.mock('./useOnboardingState', () => ({ useOnboardingState: mockUseOnboardingState }));

import { OnboardingModal } from './OnboardingModal';
import type { OnboardingStep } from './onboardingStep';

function baseState(overrides: Partial<{
  step: OnboardingStep;
  installed: boolean;
  isIOS: boolean;
  canPromptInstall: boolean;
  shouldShowModal: boolean;
  pushState: string;
}> = {}) {
  const { step = 'install', installed = false, isIOS = false, canPromptInstall = false, shouldShowModal = true, pushState = 'permission-default' } = overrides;
  return {
    step,
    installed,
    isIOS,
    canPromptInstall,
    promptInstall: promptInstallSpy,
    push: { state: pushState, enable: enableSpy, disable: vi.fn(), disconnectAll: vi.fn(), otherDeviceCount: 0, updatePending: false },
    shouldShowModal,
    dismiss: dismissSpy,
  };
}

beforeEach(() => {
  dismissSpy.mockClear();
  enableSpy.mockClear();
  promptInstallSpy.mockClear();
  mockUseOnboardingState.mockReset();
});

describe('OnboardingModal', () => {
  it('renders nothing when shouldShowModal is false', () => {
    mockUseOnboardingState.mockReturnValue(baseState({ shouldShowModal: false }));
    render(<OnboardingModal />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the welcome title and the Android/Chrome install CTA when a native prompt is available', () => {
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'install', isIOS: false, canPromptInstall: true }));
    render(<OnboardingModal />);
    expect(screen.getByRole('dialog', { name: 'ברוך הבא ל-AVARIA 👋' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'התקן את AVARIA' })).toBeInTheDocument();
  });

  it('clicking the install CTA invokes promptInstall()', async () => {
    const user = userEvent.setup();
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'install', isIOS: false, canPromptInstall: true }));
    render(<OnboardingModal />);
    await user.click(screen.getByRole('button', { name: 'התקן את AVARIA' }));
    expect(promptInstallSpy).toHaveBeenCalledTimes(1);
  });

  it('shows iOS-specific instructions (no install button) on an uninstalled iPhone', () => {
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'install', isIOS: true, canPromptInstall: false }));
    render(<OnboardingModal />);
    expect(screen.getByText(/שיתוף/)).toBeInTheDocument();
    expect(screen.getByText(/הוסף למסך הבית/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'התקן את AVARIA' })).not.toBeInTheDocument();
  });

  it('shows the notifications CTA and calls push.enable() on an explicit click', async () => {
    const user = userEvent.setup();
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'notifications', pushState: 'permission-default' }));
    render(<OnboardingModal />);
    expect(screen.getByText('נשאר עוד דבר אחד')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'אפשר התראות' }));
    expect(enableSpy).toHaveBeenCalledTimes(1);
  });

  it('shows blocked guidance (no enable button, never re-prompts) when permission is denied', () => {
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'notifications', pushState: 'permission-denied' }));
    render(<OnboardingModal />);
    expect(screen.getByText(/חסומות כרגע בדפדפן/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'אפשר התראות' })).not.toBeInTheDocument();
  });

  it('shows the completed screen and closes on its own button', async () => {
    const user = userEvent.setup();
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'done' }));
    render(<OnboardingModal />);
    expect(screen.getByText('✅ AVARIA מוכנה לעבודה')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'כניסה ל-AVARIA' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"אחר כך" records the dismissal and closes the modal', async () => {
    const user = userEvent.setup();
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'install', isIOS: false, canPromptInstall: true }));
    render(<OnboardingModal />);
    await user.click(screen.getByRole('button', { name: 'אחר כך' }));
    expect(dismissSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('once postponed, does not reopen even if shouldShowModal would recompute true on a rerender', async () => {
    const user = userEvent.setup();
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'install', isIOS: false, canPromptInstall: true }));
    const { rerender } = render(<OnboardingModal />);
    await user.click(screen.getByRole('button', { name: 'אחר כך' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Simulate the hook still reporting shouldShowModal=true on a later
    // render (e.g. another component re-rendered this tree) -- the modal
    // must not spring back open mid-session after an explicit postponement.
    mockUseOnboardingState.mockReturnValue(baseState({ step: 'install', isIOS: false, canPromptInstall: true, shouldShowModal: true }));
    rerender(<OnboardingModal />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
