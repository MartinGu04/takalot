import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsFilterBar, DEFAULT_ANALYTICS_FILTERS, isDefaultAnalyticsFilters } from './AnalyticsFilterBar';
import type { AnalyticsFilters } from '../../domain/analyticsSummary';

function renderBar(value: AnalyticsFilters = DEFAULT_ANALYTICS_FILTERS) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(<AnalyticsFilterBar value={value} onChange={onChange} onReset={onReset} systems={[]} locations={[]} />);
  return { onChange, onReset };
}

describe('isDefaultAnalyticsFilters', () => {
  it('is true only for the untouched default filter set', () => {
    expect(isDefaultAnalyticsFilters(DEFAULT_ANALYTICS_FILTERS)).toBe(true);
    expect(isDefaultAnalyticsFilters({ ...DEFAULT_ANALYTICS_FILTERS, severities: ['high'] })).toBe(false);
    expect(isDefaultAnalyticsFilters({ ...DEFAULT_ANALYTICS_FILTERS, domains: ['equipment'] })).toBe(false);
    expect(isDefaultAnalyticsFilters({ ...DEFAULT_ANALYTICS_FILTERS, includeUnclassifiedDomain: true })).toBe(false);
    expect(isDefaultAnalyticsFilters({ ...DEFAULT_ANALYTICS_FILTERS, confirmedCauses: ['equipment'] })).toBe(false);
    expect(isDefaultAnalyticsFilters({ ...DEFAULT_ANALYTICS_FILTERS, treatmentOutcomes: ['other'] })).toBe(false);
  });
});

describe('AnalyticsFilterBar: desktop primary row', () => {
  it('adds a severity chip via the multi-select and removes it again by clicking the chip', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();

    await user.selectOptions(screen.getByLabelText('סינון לפי חומרה'), 'critical');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ severities: ['critical'] }));

    // Re-render with the chip now applied, to exercise removal.
    const { onChange: onChange2 } = renderBar({ ...DEFAULT_ANALYTICS_FILTERS, severities: ['critical'] });
    await user.click(screen.getByRole('button', { name: 'הסרת סינון: קריטית' }));
    expect(onChange2).toHaveBeenLastCalledWith(expect.objectContaining({ severities: undefined }));
  });

  it('disables the reset button exactly when the filters are already default', () => {
    renderBar(DEFAULT_ANALYTICS_FILTERS);
    expect(screen.getByRole('button', { name: 'איפוס סינונים' })).toBeDisabled();
  });

  it('enables the reset button once a filter is active, and calls onReset when clicked', async () => {
    const user = userEvent.setup();
    const { onReset } = renderBar({ ...DEFAULT_ANALYTICS_FILTERS, systemId: 'sys-1' });
    const resetButton = screen.getByRole('button', { name: 'איפוס סינונים' });
    expect(resetButton).toBeEnabled();
    await user.click(resetButton);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe('AnalyticsFilterBar: advanced disclosure', () => {
  it('shows no count badge when collapsed and no advanced filter is active', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'סינון מתקדם' })).toBeInTheDocument();
  });

  it('shows an active count badge on the collapsed trigger once an advanced filter is set', () => {
    renderBar({ ...DEFAULT_ANALYTICS_FILTERS, domains: ['equipment', 'software'], includeUnclassifiedDomain: true });
    expect(screen.getByRole('button', { name: 'סינון מתקדם (3)' })).toBeInTheDocument();
  });

  it('expands to reveal domain/confirmed-cause/treatment-outcome fields and the "לא סווג" chip', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'סינון מתקדם' }));
    expect(screen.getByLabelText('סינון לפי תחום')).toBeInTheDocument();
    expect(screen.getByLabelText('סינון לפי גורם שאומת')).toBeInTheDocument();
    expect(screen.getByLabelText('סינון לפי תוצאת טיפול')).toBeInTheDocument();
    expect(screen.getByText('לא סווג בעת פתיחת התקלה')).toBeInTheDocument();
  });

  it('shows the closure-scope caveat only once a confirmed-cause or treatment-outcome filter is active', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'סינון מתקדם' }));
    expect(screen.queryByText(/מסנן לפי סיווג סגירה/)).not.toBeInTheDocument();

    renderBar({ ...DEFAULT_ANALYTICS_FILTERS, confirmedCauses: ['equipment'] });
    await user.click(screen.getAllByRole('button', { name: /סינון מתקדם/ })[1]);
    expect(screen.getByText(/מסנן לפי סיווג סגירה/)).toBeInTheDocument();
  });
});

describe('AnalyticsFilterBar: mobile sheet', () => {
  it('shows the active-filter count on the "סינון" trigger', () => {
    renderBar({ ...DEFAULT_ANALYTICS_FILTERS, systemId: 'sys-1', severities: ['high', 'low'] });
    expect(screen.getByRole('button', { name: 'סינון (3)' })).toBeInTheDocument();
  });

  it('opens as a draft that only commits on "החל", never applying mid-edit', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();

    await user.click(screen.getByRole('button', { name: 'סינון' }));
    const dialog = screen.getByRole('dialog', { name: 'סינון' });
    await user.selectOptions(within(dialog).getByLabelText('סינון לפי חומרה'), 'high');
    // Selecting inside the sheet must not have applied yet.
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'החל' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ severities: ['high'] }));
    // The sheet closes after applying.
    expect(screen.queryByRole('dialog', { name: 'סינון' })).not.toBeInTheDocument();
  });

  it('"איפוס" clears the draft back to just the current period, discarding unsaved picks on "החל"', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar({ ...DEFAULT_ANALYTICS_FILTERS, periodDays: 90, systemId: 'sys-1' });

    await user.click(screen.getByRole('button', { name: 'סינון (1)' }));
    const dialog = screen.getByRole('dialog', { name: 'סינון' });
    await user.click(within(dialog).getByRole('button', { name: 'איפוס' }));
    await user.click(within(dialog).getByRole('button', { name: 'החל' }));

    expect(onChange).toHaveBeenCalledWith({ periodDays: 90 });
  });

  it('discards the draft entirely if the sheet is closed without applying', async () => {
    const user = userEvent.setup();
    const { onChange } = renderBar();

    await user.click(screen.getByRole('button', { name: 'סינון' }));
    const dialog = screen.getByRole('dialog', { name: 'סינון' });
    await user.selectOptions(within(dialog).getByLabelText('סינון לפי חומרה'), 'critical');
    await user.click(within(dialog).getByRole('button', { name: 'סגירת החלון' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
