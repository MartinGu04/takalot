import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedField } from './useDebouncedField';

describe('useDebouncedField', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('updates the local draft synchronously on every keystroke', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedField('', onCommit, 300));
    act(() => result.current[1]('ב'));
    expect(result.current[0]).toBe('ב');
    act(() => result.current[1]('בט'));
    expect(result.current[0]).toBe('בט');
    // Nothing committed yet -- typing must not be interrupted by a commit.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits only once, after the debounce delay elapses following the last keystroke', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedField('', onCommit, 300));
    act(() => result.current[1]('ב'));
    act(() => vi.advanceTimersByTime(150));
    act(() => result.current[1]('בט'));
    act(() => vi.advanceTimersByTime(150));
    expect(onCommit).not.toHaveBeenCalled(); // reset by the second keystroke
    act(() => result.current[1]('בטא'));
    act(() => vi.advanceTimersByTime(299));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('בטא');
  });

  it('resyncs the draft when the external value changes for a reason other than our own commit', () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(({ value }) => useDebouncedField(value, onCommit, 300), {
      initialProps: { value: '' },
    });
    act(() => result.current[1]('local typing'));
    expect(result.current[0]).toBe('local typing');

    // Simulate an external change (e.g. browser back/forward, a "clear
    // filters" action) landing before our debounce fires.
    rerender({ value: 'external value' });
    expect(result.current[0]).toBe('external value');
  });

  it('does not fight its own just-committed value on the round trip back down', () => {
    const commits: string[] = [];
    let currentValue = '';
    const onCommit = (next: string) => {
      commits.push(next);
      currentValue = next;
    };
    const { result, rerender } = renderHook(({ value }) => useDebouncedField(value, onCommit, 300), {
      initialProps: { value: currentValue },
    });
    act(() => result.current[1]('בטא'));
    act(() => vi.advanceTimersByTime(300));
    expect(commits).toEqual(['בטא']);

    // The parent re-renders with the committed value flowing back down as a
    // prop -- this must not visibly reset/flicker the draft.
    rerender({ value: currentValue });
    expect(result.current[0]).toBe('בטא');
  });

  it('clearing the field commits an empty value after the debounce', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedField('בטא', onCommit, 300));
    act(() => result.current[1](''));
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenCalledWith('');
  });
});
