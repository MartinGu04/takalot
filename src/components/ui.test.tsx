// Focused tests for shared UI primitives whose whole point is an
// accessibility contract rather than a visual one.
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Avatar, DateTimeLocalInput, TruncatedTooltip } from './ui';

describe('Avatar', () => {
  it('renders the provider image over the initial when a URL is available', () => {
    const { container } = render(
      <Avatar src="https://lh3.googleusercontent.com/a/photo" name="דנה לוי" className="size-10" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/photo');
    // The image is decorative: the adjacent name is the accessible label.
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('keeps the initial rendered underneath, so a slow image shows no blank or shifting box', () => {
    const { container } = render(<Avatar src="https://example.test/a.png" name="דנה לוי" className="size-10" />);
    // Both present simultaneously: the box is sized by the span and its text,
    // and the absolutely positioned image cannot change that box.
    expect(container.textContent).toBe('ד');
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveClass('absolute');
    expect(img).toHaveClass('inset-0');
  });

  it('falls back to the initial when the image fails to load', () => {
    const { container } = render(<Avatar src="https://example.test/gone.png" name="דנה לוי" className="size-10" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('ד');
  });

  it('renders the initial alone when no URL is available', () => {
    const { container } = render(<Avatar src={null} name="דנה לוי" className="size-10" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('ד');
  });

  it('retries when the URL changes, so one failure does not suppress a later image', () => {
    const { container, rerender } = render(<Avatar src="https://example.test/gone.png" name="דנה לוי" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    rerender(<Avatar src="https://example.test/new.png" name="דנה לוי" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.test/new.png');
  });

  it('keeps the call site\'s own size and shape classes', () => {
    const { container } = render(
      <Avatar src={null} name="דנה לוי" className="flex size-10 shrink-0 rounded-full bg-gradient-to-br" />,
    );
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveClass('size-10');
    expect(box).toHaveClass('rounded-full');
    expect(box).toHaveClass('shrink-0');
  });
});

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

describe('DateTimeLocalInput', () => {
  // Native <input type="datetime-local"> corrupts manual keyboard editing
  // when kept fully controlled (value + onChange feeding straight back into
  // value): every keystroke on an already-complete value re-fires onChange
  // -> setState -> re-render, which reassigns the DOM node's .value -- and
  // browsers respond to any such reassignment (even to an identical string)
  // by resetting the control's focused segment back to the first one,
  // corrupting whatever the user types next. This harness exposes both the
  // committed value (what validation/duration/submission would see) and the
  // DOM node itself, so these tests can check the actual fix: the node is
  // never recreated -- and `value` never handed back to it -- for edits that
  // originate from the field's own onChange.
  function Harness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return (
      <div>
        <DateTimeLocalInput
          id="closure-time"
          aria-invalid={false}
          value={value}
          onChange={setValue}
        />
        <p data-testid="committed">{value}</p>
        <button type="button" onClick={() => setValue('2026-07-19T16:06')}>
          external-reset
        </button>
      </div>
    );
  }

  it('never reassigns the DOM node for edits that originate from its own onChange -- no remount, no forced focus/segment reset', () => {
    const { container } = render(<Harness initial="2026-01-01T00:00" />);
    const getField = () => container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    const node = getField();

    fireEvent.change(node, { target: { value: '2026-07-01T00:00' } }); // month
    expect(getField()).toBe(node);
    fireEvent.change(node, { target: { value: '2026-07-19T00:00' } }); // day
    expect(getField()).toBe(node);
    fireEvent.change(node, { target: { value: '2026-07-19T16:06' } }); // hour + minute
    expect(getField()).toBe(node);

    expect(screen.getByTestId('committed')).toHaveTextContent('2026-07-19T16:06');
  });

  it('ignores an intermediate empty value while a segment is mid-edit, never corrupting the already-committed value', () => {
    render(<Harness initial="2026-07-19T16:05" />);
    const input = document.getElementById('closure-time') as HTMLInputElement;

    // datetime-local reports "" while a segment is only partially typed --
    // this must never propagate up and clear the committed value.
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-07-19T16:05');
  });

  it('only a caller-driven change to `value` (not the field\'s own onChange) remounts the field with the new value', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initial="2026-01-01T00:00" />);
    const before = container.querySelector('input[type="datetime-local"]');

    await user.click(screen.getByRole('button', { name: 'external-reset' }));

    const after = container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    expect(after).not.toBe(before);
    expect(after.value).toBe('2026-07-19T16:06');
  });

  it('renders left-to-right regardless of the surrounding RTL document direction', () => {
    render(<Harness initial="2026-01-01T00:00" />);
    const input = document.getElementById('closure-time') as HTMLInputElement;
    expect(input).toHaveAttribute('dir', 'ltr');
    expect(input.className).toContain('text-left');
  });
});
