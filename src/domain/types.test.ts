import { describe, expect, it } from 'vitest';
import { isOpen, OPEN_STATUSES } from './types';
import type { IncidentStatus } from './types';

describe('isOpen', () => {
  it('is false for both terminal statuses', () => {
    expect(isOpen('closed')).toBe(false);
    expect(isOpen('cancelled')).toBe(false);
  });

  it('is true for every pre-existing open status', () => {
    const preExistingOpen: IncidentStatus[] = [
      'new',
      'acknowledged',
      'in_progress',
      'waiting_external',
      'waiting_test',
      'monitoring',
      'partial_readiness',
      'resolved_pending_close',
      'reopened',
    ];
    for (const status of preExistingOpen) {
      expect(isOpen(status)).toBe(true);
    }
  });

  it('is true for the three new Chapter 2 waiting_* statuses', () => {
    expect(isOpen('waiting_equipment')).toBe(true);
    expect(isOpen('waiting_information')).toBe(true);
    expect(isOpen('waiting_validation')).toBe(true);
  });
});

describe('OPEN_STATUSES', () => {
  it('includes the three new waiting_* statuses and excludes cancelled/closed', () => {
    expect(OPEN_STATUSES).toContain('waiting_equipment');
    expect(OPEN_STATUSES).toContain('waiting_information');
    expect(OPEN_STATUSES).toContain('waiting_validation');
    expect(OPEN_STATUSES).not.toContain('cancelled');
    expect(OPEN_STATUSES).not.toContain('closed');
  });

  it('agrees exactly with isOpen for every IncidentStatus value', () => {
    const all: IncidentStatus[] = [
      'new',
      'acknowledged',
      'in_progress',
      'waiting_external',
      'waiting_test',
      'monitoring',
      'partial_readiness',
      'resolved_pending_close',
      'closed',
      'reopened',
      'cancelled',
      'waiting_equipment',
      'waiting_information',
      'waiting_validation',
    ];
    for (const status of all) {
      expect(OPEN_STATUSES.includes(status)).toBe(isOpen(status));
    }
  });
});
