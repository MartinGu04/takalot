// AnalyticsInfoTooltip (ⓘ): must work identically for touch (click-toggle)
// and keyboard (focus/Escape), and must expose its explanation to screen
// readers regardless of the sighted popover's open/closed state.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsInfoTooltip } from './AnalyticsInfoTooltip';

describe('AnalyticsInfoTooltip', () => {
  it('the explanation is present in the DOM (sr-only) even before the trigger is ever activated', () => {
    render(<AnalyticsInfoTooltip text="הסבר לדוגמה." />);
    expect(screen.getByText('הסבר לדוגמה.', { selector: '.sr-only' })).toBeInTheDocument();
  });

  it('click toggles the visible popover open, then closed again', async () => {
    const user = userEvent.setup();
    render(<AnalyticsInfoTooltip text="הסבר לדוגמה." />);
    const trigger = screen.getByRole('button', { name: 'מידע נוסף' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keyboard focus alone opens the popover (no click required)', async () => {
    const user = userEvent.setup();
    render(<AnalyticsInfoTooltip text="הסבר לדוגמה." />);
    const trigger = screen.getByRole('button', { name: 'מידע נוסף' });
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('Escape closes an open popover', async () => {
    const user = userEvent.setup();
    render(<AnalyticsInfoTooltip text="הסבר לדוגמה." />);
    const trigger = screen.getByRole('button', { name: 'מידע נוסף' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking outside the trigger/panel closes an open popover', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <AnalyticsInfoTooltip text="הסבר לדוגמה." />
        <button type="button">אחר</button>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'מידע נוסף' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'אחר' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('the trigger has an accessible name independent of any surrounding label text', () => {
    render(<AnalyticsInfoTooltip text="הסבר לדוגמה." />);
    expect(screen.getByRole('button', { name: 'מידע נוסף' })).toBeInTheDocument();
  });
});
