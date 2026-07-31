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

  describe('cancelled (Chapter 2)', () => {
    it('never allows a self-transition on an already-cancelled incident (terminal, matches is_valid_transition)', () => {
      expect(canTransition('cancelled', 'cancelled')).toBe(false);
    });

    it('never allows transitioning out of cancelled', () => {
      expect(canTransition('cancelled', 'in_progress')).toBe(false);
      expect(canTransition('cancelled', 'new')).toBe(false);
    });

    it('never allows a direct transition to cancelled (reachable only through its own dedicated flow)', () => {
      expect(canTransition('in_progress', 'cancelled')).toBe(false);
      expect(canTransition('new', 'cancelled')).toBe(false);
    });
  });

  describe('waiting_equipment / waiting_information / waiting_validation (Chapter 2)', () => {
    it('waiting_information/waiting_validation are reachable targets (0028: מצב הטיפול\'s "בהמתנה" sub-reasons)', () => {
      expect(canTransition('in_progress', 'waiting_information')).toBe(true);
      expect(canTransition('monitoring', 'waiting_validation')).toBe(true);
      expect(canTransition('waiting_external', 'waiting_information')).toBe(true);
    });

    it('waiting_equipment is NOT a reachable target -- not one of the three named "בהמתנה" reasons', () => {
      expect(canTransition('in_progress', 'waiting_equipment')).toBe(false);
    });

    it('new\'s own explicit target list is unaffected by the 0028 widening', () => {
      expect(canTransition('new', 'waiting_information')).toBe(false);
    });

    it('still allow outgoing transitions to every normal active target, matching any other non-terminal status', () => {
      expect(canTransition('waiting_equipment', 'in_progress')).toBe(true);
      expect(canTransition('waiting_information', 'monitoring')).toBe(true);
      expect(canTransition('waiting_validation', 'resolved_pending_close')).toBe(true);
    });
  });
});
