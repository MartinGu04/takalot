// Focused tests for shared UI primitives whose whole point is an
// accessibility contract rather than a visual one.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TruncatedTooltip } from './ui';

describe('TruncatedTooltip', () => {
  it('keeps the visible text truncated but never drops the full value', () => {
    render(<TruncatedTooltip text="שם ארוך במיוחד של איש צוות" />);
    const trigger = screen.getByText('שם ארוך במיוחד של איש צוות', { selector: 'span[tabindex]' });
    expect(trigger).toHaveClass('truncate');
    // The complete value is present as a tooltip node, not only as the
    // clipped visual string.
    expect(screen.getByRole('tooltip')).toHaveTextContent('שם ארוך במיוחד של איש צוות');
  });

  it('associates the tooltip with the text via aria-describedby', () => {
    render(<TruncatedTooltip text="דנה לוי" />);
    const trigger = screen.getByText('דנה לוי', { selector: 'span[tabindex]' });
    const tooltip = screen.getByRole('tooltip');
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
    expect(tooltip.id).toBeTruthy();
  });

  it('is reachable by keyboard, so the reveal is not pointer-only', async () => {
    const user = userEvent.setup();
    render(<TruncatedTooltip text="יואב כהן" />);
    const trigger = screen.getByText('יואב כהן', { selector: 'span[tabindex]' });
    // A plain title= attribute cannot satisfy this: browsers render it on
    // hover only, so a keyboard user could never surface the full value.
    expect(trigger).toHaveAttribute('tabindex', '0');
    await user.tab();
    expect(trigger).toHaveFocus();
  });

  it('reveals on hover and on focus, driven by the same group state', () => {
    render(<TruncatedTooltip text="אלון ברק" />);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.className).toMatch(/group-hover\/tooltip:opacity-100/);
    expect(tooltip.className).toMatch(/group-focus-within\/tooltip:opacity-100/);
  });

  it('lets a Latin or mixed value resolve its own direction', () => {
    render(<TruncatedTooltip text="Alta Systems (IAF)" />);
    expect(screen.getByRole('tooltip')).toHaveAttribute('dir', 'auto');
  });
});
