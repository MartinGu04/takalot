// Focused, isolated coverage for the closed->open stale-state fix: this
// dialog stays mounted across opens/closes (unlike UpdateDialog, which
// remounts fresh each time), so its owner/external-handler fields must
// re-hydrate from the latest `incident` prop on every closed->open
// transition, not just once at first mount.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Incident } from '../../domain/types';
import { AssignDialog } from './AssignDialog';

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
    reportedDomain: null,
    currentSuspectedCause: null,
    currentSuspectedCauseOtherDetail: null,
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

describe('AssignDialog: re-hydrates on the closed->open transition', () => {
  it('update external contact -> open AssignDialog -> the latest contact is shown, not the stale value from initial mount', () => {
    const original = makeIncident({ externalHandlerContactPerson: 'איש קשר מקורי' });
    const { rerender } = render(
      <AssignDialog open={false} onClose={() => {}} incident={original} onSubmit={() => {}} submitting={false} />,
    );

    // The incident changes (e.g. via UpdateDialog, elsewhere on the page)
    // while this dialog remains mounted-but-closed.
    const updated = makeIncident({ externalHandlerContactPerson: 'איש קשר מעודכן' });
    rerender(
      <AssignDialog open={false} onClose={() => {}} incident={updated} onSubmit={() => {}} submitting={false} />,
    );

    // Now opened for the first time since the change.
    rerender(
      <AssignDialog open onClose={() => {}} incident={updated} onSubmit={() => {}} submitting={false} />,
    );

    expect(screen.getByLabelText('איש קשר')).toHaveValue('איש קשר מעודכן');
    expect(screen.queryByDisplayValue('איש קשר מקורי')).not.toBeInTheDocument();
  });

  it('clears the note and validation errors on the closed->open transition', async () => {
    const user = userEvent.setup();
    const incident = makeIncident();
    const { rerender } = render(
      <AssignDialog open onClose={() => {}} incident={incident} onSubmit={() => {}} submitting={false} />,
    );
    await user.type(screen.getByLabelText('הערה (לא חובה)'), 'הערה זמנית');
    expect(screen.getByLabelText('הערה (לא חובה)')).toHaveValue('הערה זמנית');

    rerender(
      <AssignDialog open={false} onClose={() => {}} incident={incident} onSubmit={() => {}} submitting={false} />,
    );
    rerender(
      <AssignDialog open onClose={() => {}} incident={incident} onSubmit={() => {}} submitting={false} />,
    );
    expect(screen.getByLabelText('הערה (לא חובה)')).toHaveValue('');
  });

  it('does NOT overwrite an in-progress edit while the dialog is already open', async () => {
    const user = userEvent.setup();
    const original = makeIncident({ externalHandlerContactPerson: 'איש קשר מקורי' });
    const { rerender } = render(
      <AssignDialog open onClose={() => {}} incident={original} onSubmit={() => {}} submitting={false} />,
    );

    // The user starts editing the contact-person field...
    const contactPersonInput = screen.getByLabelText('איש קשר');
    await user.clear(contactPersonInput);
    await user.type(contactPersonInput, 'עריכה שטרם נשמרה');
    expect(contactPersonInput).toHaveValue('עריכה שטרם נשמרה');

    // ...and meanwhile the incident prop changes underneath it (e.g. a
    // background refetch), while `open` stays true the whole time.
    const refetched = makeIncident({ externalHandlerContactPerson: 'ערך שהגיע מהשרת' });
    rerender(
      <AssignDialog open onClose={() => {}} incident={refetched} onSubmit={() => {}} submitting={false} />,
    );

    // The user's unsaved edit must survive.
    expect(screen.getByLabelText('איש קשר')).toHaveValue('עריכה שטרם נשמרה');
  });
});
