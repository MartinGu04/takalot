// Isolated interaction coverage for the archive's "סינון לפי תאריך" control:
// the trigger's default/active label, the panel's open/apply/clear/cancel
// contract, and reversed-range validation -- independent of real seeded
// archive data (see ArchivePage.test.tsx for the URL/list wiring).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArchiveDateFilter } from './ArchiveDateFilter';

describe('ArchiveDateFilter', () => {
  it('shows the plain "סינון לפי תאריך" label with no date inputs visible when no range is applied', () => {
    render(<ArchiveDateFilter from={undefined} to={undefined} onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'סינון לפי תאריך' })).toBeInTheDocument();
    expect(screen.queryByLabelText('מתאריך')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('עד תאריך')).not.toBeInTheDocument();
  });

  it('opening the trigger reveals both date fields', async () => {
    const user = userEvent.setup();
    render(<ArchiveDateFilter from={undefined} to={undefined} onApply={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'סינון לפי תאריך' }));
    expect(screen.getByLabelText('מתאריך')).toBeInTheDocument();
    expect(screen.getByLabelText('עד תאריך')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'החל סינון' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'נקה' })).toBeInTheDocument();
  });

  it('displays a compact applied-range summary on the trigger when a range is active', () => {
    render(<ArchiveDateFilter from="2026-07-12" to="2026-08-02" onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole('button', { name: '12.07.2026–02.08.2026' })).toBeInTheDocument();
  });

  it('reopening the panel shows the currently applied values pre-filled', async () => {
    const user = userEvent.setup();
    render(<ArchiveDateFilter from="2026-07-12" to="2026-08-02" onApply={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '12.07.2026–02.08.2026' }));
    expect(screen.getByLabelText('מתאריך')).toHaveValue('2026-07-12');
    expect(screen.getByLabelText('עד תאריך')).toHaveValue('2026-08-02');
  });

  it('applying a valid range calls onApply with both values and closes the panel', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ArchiveDateFilter from={undefined} to={undefined} onApply={onApply} onClear={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), '2026-07-12');
    await user.type(screen.getByLabelText('עד תאריך'), '2026-08-02');
    await user.click(screen.getByRole('button', { name: 'החל סינון' }));

    expect(onApply).toHaveBeenCalledWith('2026-07-12', '2026-08-02');
    expect(screen.queryByLabelText('מתאריך')).not.toBeInTheDocument();
  });

  it('a reversed range (from later than to) is rejected with a clear message, and onApply is not called', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ArchiveDateFilter from={undefined} to={undefined} onApply={onApply} onClear={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), '2026-08-02');
    await user.type(screen.getByLabelText('עד תאריך'), '2026-07-12');
    await user.click(screen.getByRole('button', { name: 'החל סינון' }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('תאריך ההתחלה חייב להיות מוקדם מתאריך הסיום');
    // The panel stays open with the invalid values still visible so the
    // user can correct them, rather than silently discarding the entry.
    expect(screen.getByLabelText('מתאריך')).toHaveValue('2026-08-02');
  });

  it('נקה clears both values, calls onClear, and closes the panel', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<ArchiveDateFilter from="2026-07-12" to="2026-08-02" onApply={vi.fn()} onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: '12.07.2026–02.08.2026' }));
    await user.click(screen.getByRole('button', { name: 'נקה' }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('מתאריך')).not.toBeInTheDocument();
  });

  it('closing the panel (Escape) without applying does not call onApply or onClear', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onClear = vi.fn();
    render(<ArchiveDateFilter from={undefined} to={undefined} onApply={onApply} onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), '2026-07-12');
    await user.keyboard('{Escape}');

    expect(onApply).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('מתאריך')).not.toBeInTheDocument();
    // Trigger still reads as unfiltered -- the draft typed before cancelling
    // never reached the applied from/to.
    expect(screen.getByRole('button', { name: 'סינון לפי תאריך' })).toBeInTheDocument();
  });

  it('supports a one-sided range (from only, no to)', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ArchiveDateFilter from={undefined} to={undefined} onApply={onApply} onClear={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), '2026-07-12');
    await user.click(screen.getByRole('button', { name: 'החל סינון' }));

    expect(onApply).toHaveBeenCalledWith('2026-07-12', undefined);
  });

  it('shows a one-sided applied range on the trigger', () => {
    render(<ArchiveDateFilter from="2026-07-12" to={undefined} onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'מתאריך 12.07.2026' })).toBeInTheDocument();
  });
});
