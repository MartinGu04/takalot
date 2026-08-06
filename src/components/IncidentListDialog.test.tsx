// IncidentListDialog: the one reusable popup shared by every KPI card.
// Focused unit tests, independent of the dashboard/app shell.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { IncidentListDialog } from './IncidentListDialog';
import type { Incident } from '../domain/types';

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
    reportedDomain: null,
    currentSuspectedCause: null,
    currentSuspectedCauseOtherDetail: null,
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
    nextUpdateDue: '2026-01-10T16:00:00.000Z',
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

const systemName = () => 'מערכת אלפא';
const locationName = () => 'אתר 1';

describe('IncidentListDialog', () => {
  it('shows the title with the incident count, and a row per incident with number/status/system/location/severity', () => {
    render(
      <MemoryRouter>
        <IncidentListDialog
          open
          onClose={() => {}}
          titleBase="תקלות קריטיות / גבוהות"
          incidents={[makeIncident({ id: 'i1', number: '2026-001', severity: 'critical' })]}
          profiles={[]}
          systemName={systemName}
          locationName={locationName}
          emptyMessage="אין תקלות."
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('dialog', { name: 'תקלות קריטיות / גבוהות (1)' })).toBeInTheDocument();
    expect(screen.getByText('2026-001')).toBeInTheDocument();
    expect(screen.getByText('מערכת אלפא · אתר 1')).toBeInTheDocument();
    expect(screen.getByText('קריטית')).toBeInTheDocument(); // severity value
  });

  it('shows the empty-state message (not an empty list with no explanation) when there are no matching incidents', () => {
    render(
      <MemoryRouter>
        <IncidentListDialog
          open
          onClose={() => {}}
          titleBase="עדכונים באיחור"
          incidents={[]}
          profiles={[]}
          systemName={systemName}
          locationName={locationName}
          emptyMessage="אין כרגע תקלות עם עדכון באיחור."
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('dialog', { name: 'עדכונים באיחור (0)' })).toBeInTheDocument();
    expect(screen.getByText('אין כרגע תקלות עם עדכון באיחור.')).toBeInTheDocument();
  });

  it('renders a "view all" link only when viewAllHref is provided, pointing at the given deep link', () => {
    const { rerender } = render(
      <MemoryRouter>
        <IncidentListDialog
          open
          onClose={() => {}}
          titleBase="תקלות פתוחות"
          incidents={[makeIncident()]}
          profiles={[]}
          systemName={systemName}
          locationName={locationName}
          emptyMessage="אין תקלות."
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /לכל/ })).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <IncidentListDialog
          open
          onClose={() => {}}
          titleBase="תקלות פתוחות"
          incidents={[makeIncident()]}
          profiles={[]}
          systemName={systemName}
          locationName={locationName}
          emptyMessage="אין תקלות."
          viewAllHref="/incidents?overdue=1"
          viewAllLabel="לכל התקלות באיחור"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'לכל התקלות באיחור' })).toHaveAttribute(
      'href',
      '/incidents?overdue=1',
    );
  });

  it('has an accessible close button and calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <IncidentListDialog
          open
          onClose={onClose}
          titleBase="תקלות פתוחות"
          incidents={[]}
          profiles={[]}
          systemName={systemName}
          locationName={locationName}
          emptyMessage="אין תקלות."
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'סגירת החלון' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking an incident row also closes the dialog (so it does not linger behind the detail page)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <IncidentListDialog
          open
          onClose={onClose}
          titleBase="תקלות פתוחות"
          incidents={[makeIncident({ number: '2026-042' })]}
          profiles={[]}
          systemName={systemName}
          locationName={locationName}
          emptyMessage="אין תקלות."
        />
      </MemoryRouter>,
    );
    await user.click(within(screen.getByRole('dialog')).getByText('2026-042'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
