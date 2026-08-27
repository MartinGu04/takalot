import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInstallPrompt } from './useInstallPrompt';

afterEach(() => {
  delete (navigator as { standalone?: boolean }).standalone;
});

function dispatchBeforeInstallPrompt(overrides: Partial<{ prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }> = {}) {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = overrides.prompt ?? vi.fn().mockResolvedValue(undefined);
  event.userChoice = overrides.userChoice ?? Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(event);
  return event;
}

describe('useInstallPrompt', () => {
  beforeEach(() => {
    delete (navigator as { standalone?: boolean }).standalone;
  });

  it('starts as not installed, no prompt captured, in jsdom (no real standalone mode)', () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.installed).toBe(false);
    expect(result.current.canPromptInstall).toBe(false);
  });

  it('reports installed=true immediately when navigator.standalone is already set', () => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.installed).toBe(true);
  });

  it('captures beforeinstallprompt and exposes canPromptInstall=true', () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      dispatchBeforeInstallPrompt();
    });
    expect(result.current.canPromptInstall).toBe(true);
  });

  it('promptInstall() with no captured event resolves "unavailable" and never throws', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    await expect(result.current.promptInstall()).resolves.toBe('unavailable');
  });

  it('promptInstall() invokes the captured event.prompt() and resolves the real outcome', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const promptFn = vi.fn().mockResolvedValue(undefined);
    act(() => {
      dispatchBeforeInstallPrompt({ prompt: promptFn, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.promptInstall();
    });
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('dismissed');
  });

  it('a captured prompt can only be used once -- after promptInstall(), canPromptInstall goes back to false', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      dispatchBeforeInstallPrompt();
    });
    expect(result.current.canPromptInstall).toBe(true);
    await act(async () => {
      await result.current.promptInstall();
    });
    expect(result.current.canPromptInstall).toBe(false);
  });

  it('the appinstalled event marks the device installed and clears any captured prompt', () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      dispatchBeforeInstallPrompt();
    });
    expect(result.current.canPromptInstall).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current.installed).toBe(true);
    expect(result.current.canPromptInstall).toBe(false);
  });
});
