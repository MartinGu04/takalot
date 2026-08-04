// IncidentCard: focused unit tests for the critical-severity visual
// accent (independent of any specific seeded data).
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentCard, StatusBadge, SeverityBadge } from './incident';
import { statusLabels, severityLabels } from '../domain/labels';
import type { Incident, IncidentStatus, Profile, Severity } from '../domain/types';

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
    externalHandlerName: null,
    externalHandlerContactPerson: null,
    externalHandlerContactDetails: null,
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

function renderCard(incident: Incident, live = false) {
  cleanup();
  render(
    <MemoryRouter>
      <IncidentCard
        incident={incident}
        profiles={[]}
        systemName="מערכת"
        locationName="אתר"
        now={NOW}
        live={live}
      />
    </MemoryRouter>,
  );
  return screen.getByRole('link').className;
}

describe('IncidentCard: severity accent (static, both contexts)', () => {
  it('a critical incident gets the critical (red) accent', () => {
    const className = renderCard(makeIncident({ severity: 'critical' }));
    expect(className).toMatch(/incident-card-accent-critical/);
  });

  it('a high incident gets the high (amber/orange) accent, distinct from critical', () => {
    const className = renderCard(makeIncident({ severity: 'high' }));
    expect(className).toMatch(/incident-card-accent-high/);
    expect(className).not.toMatch(/incident-card-accent-critical/);
  });

  it('medium and low incidents get no accent class at all', () => {
    for (const severity of ['medium', 'low'] as const) {
      const className = renderCard(makeIncident({ severity }));
      expect(className).not.toMatch(/incident-card-accent/);
    }
  });
});

describe('IncidentCard: live pulse (current-state/home view only)', () => {
  it('a critical incident in the live/current-state context gets the animated critical pulse, on top of the static red accent', () => {
    const className = renderCard(makeIncident({ severity: 'critical' }), true);
    expect(className).toMatch(/incident-card-accent-critical/);
    expect(className).toMatch(/incident-card-pulse-critical/);
  });

  it('a high incident in the live/current-state context gets the animated amber/orange pulse, on top of the static amber/orange accent', () => {
    const className = renderCard(makeIncident({ severity: 'high' }), true);
    expect(className).toMatch(/incident-card-accent-high/);
    expect(className).toMatch(/incident-card-pulse-high/);
  });

  it('a critical incident on a static page (live=false, e.g. the incidents/archive pages) stays red with no pulse', () => {
    const className = renderCard(makeIncident({ severity: 'critical' }), false);
    expect(className).toMatch(/incident-card-accent-critical/);
    expect(className).not.toMatch(/incident-card-pulse/);
  });

  it('a high incident on a static page (live=false) stays amber/orange with no pulse', () => {
    const className = renderCard(makeIncident({ severity: 'high' }), false);
    expect(className).toMatch(/incident-card-accent-high/);
    expect(className).not.toMatch(/incident-card-pulse/);
  });

  it('medium and low incidents never get a pulse class, even in the live/current-state context', () => {
    for (const severity of ['medium', 'low'] as const) {
      const className = renderCard(makeIncident({ severity }), true);
      expect(className).not.toMatch(/incident-card-pulse/);
    }
  });
});

describe('SeverityBadge: color hierarchy', () => {
  function renderBadge(severity: Severity): string {
    cleanup();
    render(<SeverityBadge severity={severity} />);
    return screen.getByText(severityLabels[severity]).className;
  }

  it('medium uses its own restrained yellow/gold treatment', () => {
    const className = renderBadge('medium');
    expect(className).toMatch(/bg-yellow-100/);
    expect(className).toMatch(/text-yellow-900/);
    expect(className).toMatch(/dark:bg-yellow-950/);
    expect(className).toMatch(/dark:text-yellow-200/);
  });

  it('medium is visually distinct from high (orange) and low (neutral gray)', () => {
    const medium = renderBadge('medium');
    const high = renderBadge('high');
    const low = renderBadge('low');
    expect(medium).not.toMatch(/orange/);
    expect(high).not.toMatch(/yellow/);
    expect(medium).not.toMatch(/bg-surface-active/);
    expect(low).not.toMatch(/yellow/);
  });

  it('low remains the only neutral gray severity badge', () => {
    const className = renderBadge('low');
    expect(className).toMatch(/bg-surface-active/);
    expect(className).toMatch(/text-text-secondary/);
    expect(className).not.toMatch(/red|orange|yellow/);
  });

  it('critical and high are unchanged (red and orange respectively)', () => {
    const critical = renderBadge('critical');
    expect(critical).toMatch(/bg-red-100/);
    expect(critical).toMatch(/dark:bg-red-950/);

    const high = renderBadge('high');
    expect(high).toMatch(/bg-orange-100/);
    expect(high).toMatch(/dark:bg-orange-950/);
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
  {
    systemName = 'מערכת',
    locationName = 'אתר',
    profiles = [],
  }: { systemName?: string; locationName?: string; profiles?: Profile[] } = {},
) {
  const view = render(
    <MemoryRouter>
      <IncidentCard
        incident={incident}
        profiles={profiles}
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
    const impact = screen.getByText('תיאור השפעה').closest('p') as HTMLElement;
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

  it('resolves a mixed Hebrew+Latin internal owner name by its own direction: טיפול של אלתא (IAF)', () => {
    // Compact cards render the internal owner only -- never the external
    // handling party as a substitute -- so this RTL-resolution case now
    // exercises a profile whose own full name is mixed Hebrew+Latin.
    renderCardWith(makeIncident({ ownerUserId: 'p-mixed' }), {
      profiles: [{ id: 'p-mixed', fullName: 'טיפול של אלתא (IAF)', role: 'technician', active: true, createdAt: NOW.toISOString() }],
    });
    const owner = screen.getByText('טיפול של אלתא (IAF)');
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

describe('IncidentCard: labeled השפעה מבצעית row', () => {
  it('shows the השפעה מבצעית: label, anchored to the RTL row, when a value exists', () => {
    renderCardWith(makeIncident({ operationalImpact: 'תיאור השפעה' }));
    const row = screen.getByText('תיאור השפעה').closest('p') as HTMLElement;
    expect(row.textContent).toMatch(/^השפעה מבצעית: /);
  });

  it('keeps an English-only value inside the operational-impact row -- never drifting into the metadata column beside it', () => {
    const container = renderCardWith(
      makeIncident({ operationalImpact: 'Radar feed degraded, standby' }),
    );
    const value = screen.getByText('Radar feed degraded, standby');
    // Bidi-isolated via <bdi>, not a block-level dir="auto" that could flip
    // the whole row (and its text-start alignment) to LTR.
    expect(value.tagName).toBe('BDI');
    const row = value.closest('p') as HTMLElement;
    expect(row.textContent).toMatch(/^השפעה מבצעית: /);
    expect(row).toHaveClass('text-start');
    // The metadata column (status/owner/last-updated) never contains it.
    const metadata = container.querySelector('.sm\\:border-s') as HTMLElement;
    expect(metadata.contains(value)).toBe(false);
    expect(metadata.textContent).not.toContain('Radar feed degraded');
  });

  it('renders a Hebrew value correctly', () => {
    renderCardWith(makeIncident({ operationalImpact: 'אין יכולת הפעלה מלאה של המערכת' }));
    const value = screen.getByText('אין יכולת הפעלה מלאה של המערכת');
    expect(value.tagName).toBe('BDI');
    expect(value).toHaveAttribute('dir', 'auto');
  });

  it('uses bidirectional isolation (<bdi dir="auto">) for a mixed Hebrew/English value', () => {
    renderCardWith(makeIncident({ operationalImpact: 'תקלה בשרת Server-42 בבניין A' }));
    const value = screen.getByText('תקלה בשרת Server-42 בבניין A');
    expect(value.tagName).toBe('BDI');
    expect(value).toHaveAttribute('dir', 'auto');
  });

  it('shows no operational-impact row at all for an empty value -- unchanged from the existing (unlabeled) behavior', () => {
    renderCardWith(makeIncident({ operationalImpact: '' }));
    expect(screen.queryByText(/השפעה מבצעית/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Owner/creator identity (avatar)
// ---------------------------------------------------------------------------

describe('IncidentCard: current internal owner identity', () => {
  it("shows the owner's real stored avatar image beside their name", () => {
    const container = renderCardWith(makeIncident({ ownerUserId: 'p-owner' }), {
      profiles: [
        {
          id: 'p-owner',
          fullName: 'דנה לוי',
          role: 'shift_supervisor',
          active: true,
          createdAt: NOW.toISOString(),
          avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
        },
      ],
    });
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/photo');
    expect(screen.getByText('דנה לוי')).toBeInTheDocument();
  });

  it('falls back to an initial when the owner has no stored avatar', () => {
    const container = renderCardWith(makeIncident({ ownerUserId: 'p-owner' }), {
      profiles: [
        { id: 'p-owner', fullName: 'דנה לוי', role: 'shift_supervisor', active: true, createdAt: NOW.toISOString() },
      ],
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('ד');
  });

  it('renders no owner avatar at all when the incident has no internal owner', () => {
    const container = renderCardWith(makeIncident({ ownerUserId: null }));
    // No image, and no initials bubble for a nonexistent identity -- only
    // the "ללא בעל אחריות פנימי" text itself.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('ללא בעל אחריות פנימי')).toBeInTheDocument();
  });

  it('shows a secondary "נפתח על ידי" line when the creator differs from the current owner', () => {
    renderCardWith(makeIncident({ ownerUserId: 'p-owner', createdBy: 'p-creator' }), {
      profiles: [
        { id: 'p-owner', fullName: 'דנה לוי', role: 'shift_supervisor', active: true, createdAt: NOW.toISOString() },
        { id: 'p-creator', fullName: 'יואב כהן', role: 'technician', active: true, createdAt: NOW.toISOString() },
      ],
    });
    expect(screen.getByText('נפתח על ידי יואב כהן')).toBeInTheDocument();
  });

  it('omits the creator line when the creator is the same person as the current owner (no redundant repeat)', () => {
    renderCardWith(makeIncident({ ownerUserId: 'p-owner', createdBy: 'p-owner' }), {
      profiles: [
        { id: 'p-owner', fullName: 'דנה לוי', role: 'shift_supervisor', active: true, createdAt: NOW.toISOString() },
      ],
    });
    expect(screen.queryByText(/נפתח על ידי/)).not.toBeInTheDocument();
  });
});
