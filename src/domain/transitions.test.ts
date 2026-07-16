import { describe, expect, it } from 'vitest';
import { canTransition } from './transitions';

describe('status transitions', () => {
  it('allows new -> acknowledged and new -> in_progress', () => {
    expect(canTransition('new', 'acknowledged')).toBe(true);
    expect(canTransition('new', 'in_progress')).toBe(true);
  });

  it('rejects new -> waiting_external directly', () => {
    expect(canTransition('new', 'waiting_external')).toBe(false);
  });

  it('never allows a direct transition to closed', () => {
    expect(canTransition('in_progress', 'closed')).toBe(false);
    expect(canTransition('new', 'closed')).toBe(false);
    expect(canTransition('monitoring', 'closed')).toBe(false);
  });

  it('never allows a direct transition to reopened', () => {
    expect(canTransition('in_progress', 'reopened')).toBe(false);
  });

  it('rejects any transition out of closed (must use dedicated reopen flow)', () => {
    expect(canTransition('closed', 'in_progress')).toBe(false);
    expect(canTransition('closed', 'new')).toBe(false);
  });

  it('allows the reopened status to move to active states', () => {
    expect(canTransition('reopened', 'in_progress')).toBe(true);
    expect(canTransition('reopened', 'acknowledged')).toBe(true);
  });

  it('treats staying on the same status as valid (no-op update)', () => {
    expect(canTransition('in_progress', 'in_progress')).toBe(true);
  });

  it('allows resolved_pending_close to move back to active work', () => {
    expect(canTransition('resolved_pending_close', 'in_progress')).toBe(true);
    expect(canTransition('resolved_pending_close', 'waiting_external')).toBe(false);
  });
});
