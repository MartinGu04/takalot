// IncidentCard: focused unit tests for the critical-vs-overdue visual
// distinction (independent of any specific seeded data).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentCard } from './incident';
import type { Incident } from '../domain/types';

const NOW = new Date('2026-01-10T12:00:00.000Z');

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    number: '2026-001',
    version: 1,
    systemId: 'sys',
    locationId: 'loc',
    description: 'desc',
    severity: 'medium',
    status: 'in_progress',
    operationalImpact: 'תיאור השפעה',
    ownerUserId: null,
    ownerExternalName: null,
    discoveredAt: '2026-01-10T08:00:00.000Z',
    createdAt: '2026-01-10T08:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-01-10T08:00:00.000Z',
    updatedBy: 'u1',
    lastUpdateAt: '2026-01-10T08:00:00.000Z',
    nextUpdateDue: '2026-01-10T16:00:00.000Z', // not overdue by default
    noDeadlineReason: null,
    reportedToOps: 'no',
    reportedToOpsRecipient: null,
    closedAt: null,
    closedBy: null,
    rootCause: null,
    resolution: null,
    readinessAtClose: null,
    followUpNotes: null,
    followUpRequired: false,
    followUpCompletedAt: null,
    followUpCompletedBy: null,
    reopenCount: 0,
    ...overrides,
  };
}

function renderCard(incident: Incident) {
  render(
    <MemoryRouter>
      <IncidentCard incident={incident} profiles={[]} systemName="מערכת" locationName="אתר" now={NOW} />
    </MemoryRouter>,
  );
  return screen.getByRole('link').className;
}

describe('IncidentCard: critical vs overdue are visually distinct, never conflated', () => {
  it('a critical, non-overdue incident gets the critical (red) accent, not the overdue one', () => {
    const className = renderCard(makeIncident({ severity: 'critical' }));
    expect(className).toMatch(/incident-card-accent-critical/);
    expect(className).not.toMatch(/incident-card-accent-overdue/);
  });

  it('an overdue, non-critical incident gets the overdue (amber) accent, not the critical one', () => {
    const className = renderCard(makeIncident({ severity: 'medium', nextUpdateDue: '2026-01-10T10:00:00.000Z' }));
    expect(className).toMatch(/incident-card-accent-overdue/);
    expect(className).not.toMatch(/incident-card-accent-critical/);
  });

  it('a critical AND overdue incident gets only the critical treatment (critical takes precedence)', () => {
    const className = renderCard(makeIncident({ severity: 'critical', nextUpdateDue: '2026-01-10T10:00:00.000Z' }));
    expect(className).toMatch(/incident-card-accent-critical/);
    expect(className).not.toMatch(/incident-card-accent-overdue/);
  });

  it('a plain incident (neither critical nor overdue) gets no accent class at all', () => {
    const className = renderCard(makeIncident({ severity: 'high' }));
    expect(className).not.toMatch(/incident-card-accent/);
  });

  it('high severity alone (not overdue) does not trigger any accent', () => {
    const className = renderCard(makeIncident({ severity: 'high', nextUpdateDue: '2026-01-10T18:00:00.000Z' }));
    expect(className).not.toMatch(/incident-card-accent/);
  });
});
