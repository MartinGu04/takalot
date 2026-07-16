import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useUrlState } from './useUrlState';

function setup(initialEntry = '/') {
  return renderHook(() => useUrlState(), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>,
  });
}

describe('useUrlState', () => {
  it('set() applies a single key change', () => {
    const { result } = setup();
    act(() => result.current.set('severity', ['critical']));
    expect(result.current.get('severity')).toBe('critical');
  });

  it('documents why setMany() is required: sequential set() calls in one handler clobber each other', () => {
    // This reproduces the original defect directly (severity/owner/etc.
    // filters silently failing to apply): each set() call reads the same
    // not-yet-committed params snapshot, so only the last of several
    // sequential calls in one handler actually survives. setFilters() in
    // IncidentsPage must use setMany(), never a chain of set() calls.
    const { result } = setup();
    act(() => {
      result.current.set('q', 'אלפא');
      result.current.set('severity', ['critical']);
      result.current.set('status', ['in_progress']);
    });
    // Only the final call's key was ever going to reliably stick.
    expect(result.current.get('status')).toBe('in_progress');
    expect(result.current.get('q')).not.toBe('אלפא');
    expect(result.current.get('severity')).not.toBe('critical');
  });

  it('setMany() applies every key change atomically in one update', () => {
    const { result } = setup();
    act(() =>
      result.current.setMany({
        q: 'אלפא',
        severity: ['critical'],
        status: ['in_progress'],
        page: undefined,
      }),
    );
    expect(result.current.get('q')).toBe('אלפא');
    expect(result.current.get('severity')).toBe('critical');
    expect(result.current.get('status')).toBe('in_progress');
  });

  it('setMany() correctly removes keys set to undefined/empty while keeping others', () => {
    const { result } = setup('/?q=x&severity=critical&page=2');
    act(() => result.current.setMany({ page: undefined, severity: ['critical', 'high'] }));
    expect(result.current.get('page')).toBeUndefined();
    expect(result.current.getList('severity')).toEqual(['critical', 'high']);
    expect(result.current.get('q')).toBe('x'); // untouched key survives
  });

  it('setMany() called after set() in the same handler does not clobber it (composability fix)', () => {
    const { result } = setup();
    act(() => {
      result.current.set('q', 'x');
    });
    expect(result.current.get('q')).toBe('x');
    act(() => {
      result.current.setMany({ severity: ['low'], page: undefined });
    });
    // A prior committed (separately rendered) value must survive a later,
    // unrelated setMany call.
    expect(result.current.get('q')).toBe('x');
    expect(result.current.get('severity')).toBe('low');
  });

  it('getList parses comma-separated values back into an array', () => {
    const { result } = setup('/?status=new,in_progress');
    expect(result.current.getList('status')).toEqual(['new', 'in_progress']);
  });
});
