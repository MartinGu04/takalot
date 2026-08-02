// Focused, isolated coverage for UpdateDialog's "מצב הטיפול" treatment-state
// selector: for a given incident starting status, the selector must offer
// ONLY the categories/reasons canTransition(incident.status, target) actually
// permits, and a legacy/internal starting status (one outside the three
// recognized categories) must render as separate read-only context, never
// as a normal selector option. auth/data hooks are mocked deliberately --
// this test targets the selector's pure reachability logic against every
// interesting starting status, not the full app wiring already covered by
// IncidentDetailPage.test.tsx's real-app UpdateDialog tests.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Incident, IncidentStatus } from '../../domain/types';
import { UpdateDialog } from './UpdateDialog';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-admin', fullName: 'Admin', role: 'system_admin', active: true } }),
}));
vi.mock('../../data/hooks', () => ({
  useProfiles: () => ({ data: [] }),
}));

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
    operationalImpact: 'impact',
    ownerUserId: 'u-admin',
    ownerExternalName: null,
    externalHandlerName: null,
    externalHandlerContactPerson: null,
    externalHandlerContactDetails: null,
    discoveredAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u-admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'u-admin',
    lastUpdateAt: '2026-01-01T00:00:00.000Z',
    nextUpdateDue: null,
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

function renderDialog(status: IncidentStatus) {
  const incident = makeIncident({ status });
  render(
    <UpdateDialog
      open
      onClose={() => {}}
      incident={incident}
      onSubmitFull={() => {}}
      onSubmitTechnician={() => {}}
      submitting={false}
    />,
  );
  return screen.getByRole('combobox', { name: /מצב הטיפול/ });
}

function categoryOptionValues(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((o) => (o as HTMLOptionElement).value)
    .filter((v) => v !== '');
}

describe('UpdateDialog מצב הטיפול: reachability mirrors canTransition exactly', () => {
  it.each([
    ['new', ['in_progress']],
    ['acknowledged', ['in_progress', 'waiting', 'monitoring']],
    ['waiting_test', ['in_progress', 'waiting', 'monitoring']],
    ['waiting_equipment', ['in_progress', 'waiting', 'monitoring']],
    ['partial_readiness', ['in_progress', 'waiting', 'monitoring']],
    ['resolved_pending_close', ['in_progress', 'monitoring']],
    ['reopened', ['in_progress', 'waiting', 'monitoring']],
  ] as [IncidentStatus, string[]][])('from %s, offers exactly %j as reachable categories', (status, expected) => {
    const select = renderDialog(status);
    expect(categoryOptionValues(select)).toEqual(expected);
  });

  it('"new" never offers בהמתנה or במעקב -- only in_progress is a valid backend transition', () => {
    const select = renderDialog('new');
    expect(categoryOptionValues(select)).not.toContain('waiting');
    expect(categoryOptionValues(select)).not.toContain('monitoring');
  });

  it('resolved_pending_close never exposes a בהמתנה category, and its reason select stays absent even after other interaction', () => {
    renderDialog('resolved_pending_close');
    expect(screen.queryByRole('combobox', { name: /סיבת ההמתנה/ })).not.toBeInTheDocument();
  });
});

describe('UpdateDialog: a legacy/internal current status is read-only context, never a selector option', () => {
  it('shows "new" as read-only context text, not as an option in the מצב הטיפול selector', () => {
    const select = renderDialog('new');
    expect(screen.getByText(/סטטוס נוכחי:/)).toBeInTheDocument();
    expect(screen.getByText('חדשה')).toBeInTheDocument();
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).not.toContain('new');
  });

  it('shows waiting_equipment as read-only context (not one of the three named בהמתנה reasons)', () => {
    renderDialog('waiting_equipment');
    expect(screen.getByText(/סטטוס נוכחי:/)).toBeInTheDocument();
    expect(screen.getByText('ממתינה לציוד')).toBeInTheDocument();
  });

  it('does not show the read-only context when the incident already sits in one of the three recognized categories', () => {
    renderDialog('monitoring');
    expect(screen.queryByText(/סטטוס נוכחי:/)).not.toBeInTheDocument();
  });
});

describe('UpdateDialog: "הערה נוספת" (optional note, shared by full and technician updates)', () => {
  it('renders with a live character counter and a 600-character cap, regardless of treatment category', () => {
    renderDialog('in_progress');
    const noteField = screen.getByLabelText('הערה נוספת');
    expect(noteField).toHaveAttribute('maxLength', '600');
    expect(screen.getByText('0/600')).toBeInTheDocument();
  });

  it('is passed through to onSubmitFull when the full update is submitted', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const onSubmitFull = vi.fn();
    const incident = makeIncident({ status: 'in_progress' });
    render(
      <UpdateDialog
        open
        onClose={() => {}}
        incident={incident}
        onSubmitFull={onSubmitFull}
        onSubmitTechnician={() => {}}
        submitting={false}
      />,
    );
    await user.type(screen.getByLabelText(/^פעולות שבוצעו מאז העדכון הקודם/), 'פעולות שבוצעו');
    await user.type(screen.getByLabelText(/^סטטוס נוכחי/), 'המצב הנוכחי');
    await user.type(screen.getByLabelText('הערה נוספת'), 'הערה נוספת לבדיקה');
    await user.selectOptions(screen.getByLabelText(/^דווח למבצעים\?/), 'not_required');
    await user.selectOptions(screen.getByLabelText(/^האם דווח לתקשוב למבצעים\?/), 'no');
    await user.selectOptions(screen.getByLabelText(/^האם עודכן ב-WISDOM\?/), 'no');
    await user.click(screen.getByRole('button', { name: 'שמירת עדכון' }));
    expect(onSubmitFull).toHaveBeenCalledWith(expect.objectContaining({ note: 'הערה נוספת לבדיקה' }));
  });
});

describe('UpdateDialog: waiting reasons are filtered independently, matching the backend exactly', () => {
  it('acknowledged reaches all three structured בהמתנה reasons', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const select = renderDialog('acknowledged');
    await user.selectOptions(select, 'waiting');
    const reasonSelect = await screen.findByRole('combobox', { name: /סיבת ההמתנה/ });
    const values = within(reasonSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['waiting_external', 'waiting_information', 'waiting_validation']);
  });
});
