// IncidentCard: focused unit tests for the critical-severity visual
// accent (independent of any specific seeded data).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentCard, StatusBadge } from './incident';
import { statusLabels } from '../domain/labels';
import type { Incident, IncidentStatus } from '../domain/types';

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
    reportedToComms: false,
    reportedToCommsRecipient: null,
    wisdomReported: false,
    wisdomIncidentNumber: null,
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
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
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

describe('IncidentCard: critical-severity accent', () => {
  it('a critical incident gets the critical (red) accent', () => {
    const className = renderCard(makeIncident({ severity: 'critical' }));
    expect(className).toMatch(/incident-card-accent-critical/);
  });

  it('a non-critical incident gets no accent class at all', () => {
    const className = renderCard(makeIncident({ severity: 'high' }));
    expect(className).not.toMatch(/incident-card-accent/);
  });
});

describe('StatusBadge: Chapter 2 statuses render a label without throwing', () => {
  const CHAPTER2_STATUSES: IncidentStatus[] = [
    'cancelled',
    'waiting_equipment',
    'waiting_information',
    'waiting_validation',
  ];

  for (const status of CHAPTER2_STATUSES) {
    it(`renders the correct Hebrew label for ${status}`, () => {
      render(<StatusBadge status={status} />);
      expect(screen.getByText(statusLabels[status])).toBeInTheDocument();
    });
  }
});

// ---------------------------------------------------------------------------
// RTL / bidirectional text
// ---------------------------------------------------------------------------

function renderCardWith(
  incident: Incident,
  { systemName = 'מערכת', locationName = 'אתר' }: { systemName?: string; locationName?: string } = {},
) {
  const view = render(
    <MemoryRouter>
      <IncidentCard
        incident={incident}
        profiles={[]}
        systemName={systemName}
        locationName={locationName}
        now={NOW}
      />
    </MemoryRouter>,
  );
  return view.container;
}

describe('IncidentCard: RTL alignment and bidirectional text', () => {
  it('aligns card content to the logical start (right, under the page\'s RTL direction)', () => {
    const container = renderCardWith(makeIncident());
    const impact = screen.getByText('תיאור השפעה');
    expect(impact).toHaveClass('text-start');
    // The metadata column shares the same logical-start alignment as the
    // content beside it rather than mirroring away from it.
    const metadata = container.querySelector('.sm\\:border-s') as HTMLElement;
    expect(metadata).toHaveClass('text-start');
    expect(metadata).not.toHaveClass('text-end');
    expect(metadata).not.toHaveClass('sm:items-end');
  });

  it('places the content/metadata divider on the inline-start edge, which is the seam in RTL', () => {
    const container = renderCardWith(makeIncident());
    const metadata = container.querySelector('.sm\\:border-s') as HTMLElement;
    expect(metadata).toBeInTheDocument();
    // border-s + ps-4 are logical properties: in RTL both resolve to the
    // column's right edge -- the side facing the content column.
    expect(metadata).toHaveClass('sm:ps-4');
    expect(metadata.className).not.toMatch(/\bsm:border-e\b/);
    expect(metadata.className).not.toMatch(/\bsm:pe-4\b/);
  });

  it('resolves a mixed Hebrew+Latin handler name by its own direction: טיפול של אלתא (IAF)', () => {
    renderCardWith(makeIncident({ ownerExternalName: 'טיפול של אלתא (IAF)' }));
    const owner = screen.getByText('טיפול של אלתא (IAF) (חיצוני)');
    // dir="auto" -> the browser picks the base direction from the first
    // strong character (Hebrew "ט"), so the trailing "(IAF)" keeps its
    // parentheses on the correct side instead of being reordered.
    expect(owner).toHaveAttribute('dir', 'auto');
  });

  it('does not force a single direction onto English content', () => {
    const container = renderCardWith(
      makeIncident({ operationalImpact: 'Radar feed degraded (IAF), standby' }),
      { systemName: 'Alta Systems (IAF)', locationName: 'North Site' },
    );
    for (const text of ['Alta Systems (IAF)', 'North Site', 'Radar feed degraded (IAF), standby']) {
      expect(screen.getByText(text)).toHaveAttribute('dir', 'auto');
    }
    // Nothing on the card hard-codes a direction that would override the
    // per-string resolution above.
    expect(container.querySelector('[dir="rtl"]')).toBeNull();
    expect(container.querySelector('[dir="ltr"]')).toBeNull();
  });

  it('keeps the Hebrew label and its Latin value as separate directional runs', () => {
    renderCardWith(makeIncident(), { systemName: 'Alta Systems (IAF)' });
    const value = screen.getByText('Alta Systems (IAF)');
    expect(value).toHaveAttribute('dir', 'auto');
    // The Hebrew label lives outside the dir="auto" span, so it is not
    // dragged into the value's LTR run.
    expect(value.parentElement?.textContent).toMatch(/^מערכת: /);
  });
});
