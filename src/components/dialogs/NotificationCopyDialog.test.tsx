import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationCopyDialog } from './NotificationCopyDialog';

const MESSAGE = '🔴 נפתחה תקלה קריטית 2026-041 במערכת AVARIA על ידי מרטין גוסין';

const writeText = vi.fn();
beforeEach(() => writeText.mockClear());

// userEvent.setup() installs its OWN navigator.clipboard stub (for its
// copy()/paste() helpers), so the mock must be installed AFTER setup() runs
// in each test, not in a shared beforeEach -- otherwise setup() silently
// clobbers it and every writeText call vanishes.
function setupUserWithClipboard() {
  const user = userEvent.setup();
  writeText.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return user;
}

describe('NotificationCopyDialog: copy state machine', () => {
  it('starts with העתקת הודעה as the primary action and סיום disabled -- not the normal primary action before a successful copy', async () => {
    render(
      <NotificationCopyDialog open title="התקלה נפתחה בהצלחה" message={MESSAGE} onDismiss={() => {}} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' });
    const finish = within(dialog).getByRole('button', { name: 'סיום' });
    expect(finish).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'העתקת הודעה' })).toBeEnabled();
    // The message itself is visible and present for manual copying even
    // before any copy attempt.
    expect(within(dialog).getByText(MESSAGE)).toBeInTheDocument();
  });

  it('a successful copy copies the exact displayed message, flips the state to הועתקה ✓, and enables סיום', async () => {
    const user = setupUserWithClipboard();
    writeText.mockResolvedValueOnce(undefined);
    const onDismiss = vi.fn();
    render(
      <NotificationCopyDialog open title="התקלה נפתחה בהצלחה" message={MESSAGE} onDismiss={onDismiss} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' });
    await user.click(within(dialog).getByRole('button', { name: 'העתקת הודעה' }));

    expect(writeText).toHaveBeenCalledWith(MESSAGE);
    expect(await within(dialog).findByRole('button', { name: 'הועתקה ✓' })).toBeInTheDocument();
    const finish = within(dialog).getByRole('button', { name: 'סיום' });
    expect(finish).toBeEnabled();

    await user.click(finish);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a failed copy does not show a false success state, shows understandable feedback, and keeps the message and המשך ללא העתקה available', async () => {
    const user = setupUserWithClipboard();
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    render(
      <NotificationCopyDialog open title="התקלה נפתחה בהצלחה" message={MESSAGE} onDismiss={() => {}} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' });
    await user.click(within(dialog).getByRole('button', { name: 'העתקת הודעה' }));

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'הועתקה ✓' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'סיום' })).toBeDisabled();
    expect(within(dialog).getByText(MESSAGE)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'המשך ללא העתקה' })).toBeEnabled();
  });

  it('המשך ללא העתקה dismisses immediately, with no copy required', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <NotificationCopyDialog open title="התקלה נפתחה בהצלחה" message={MESSAGE} onDismiss={onDismiss} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'התקלה נפתחה בהצלחה' });
    await user.click(within(dialog).getByRole('button', { name: 'המשך ללא העתקה' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('never offers a "don\'t show again" suppression option', () => {
    render(
      <NotificationCopyDialog open title="התקלה נפתחה בהצלחה" message={MESSAGE} onDismiss={() => {}} />,
    );
    expect(screen.queryByText(/אל תציג שוב/)).not.toBeInTheDocument();
  });
});
