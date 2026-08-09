import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsViewSettingsDialog } from './AnalyticsViewSettingsDialog';
import { ANALYTICS_MODULE_KEYS, defaultAnalyticsModules } from '../../domain/analyticsPreferences';
import { analyticsModuleLabels } from '../../domain/labels';

function renderDialog(overrides: Partial<Parameters<typeof AnalyticsViewSettingsDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(
    <AnalyticsViewSettingsDialog
      open
      onClose={onClose}
      role="shift_supervisor"
      visibleModules={['trend', 'ageDistribution']}
      onSave={onSave}
      saving={false}
      {...overrides}
    />,
  );
  return { onClose, onSave };
}

describe('AnalyticsViewSettingsDialog', () => {
  it('renders a switch for every personalizable module, checked to match the currently-effective set', () => {
    renderDialog({ visibleModules: ['trend', 'closures'] });
    for (const key of ANALYTICS_MODULE_KEYS) {
      const label = analyticsModuleLabels[key];
      expect(screen.getByText(label)).toBeInTheDocument();
      const expectedChecked = key === 'trend' || key === 'closures';
      expect(screen.getByRole('switch', { name: label })).toHaveAttribute('aria-checked', String(expectedChecked));
    }
  });

  it('toggling a switch changes only the local draft -- onSave is not called until "שמירה"', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({ visibleModules: [] });
    const trendSwitch = screen.getByRole('switch', { name: analyticsModuleLabels.trend });
    await user.click(trendSwitch);
    expect(trendSwitch).toHaveAttribute('aria-checked', 'true');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('"שמירה" commits the draft as an explicit array once a switch was toggled', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({ visibleModules: ['trend'] });
    await user.click(screen.getByRole('switch', { name: analyticsModuleLabels.closures }));
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(onSave).toHaveBeenCalledWith(expect.arrayContaining(['trend', 'closures']));
    const saved = onSave.mock.calls[0][0] as string[];
    expect(saved).toHaveLength(2);
  });

  it('"אפס לברירת מחדל" resets every switch to the role default, and "שמירה" afterward saves null (reset-to-default), not the literal array', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({ role: 'professional_manager', visibleModules: ['trend'] });
    await user.click(screen.getByRole('button', { name: 'אפס לברירת מחדל' }));

    for (const key of defaultAnalyticsModules('professional_manager')) {
      expect(screen.getByRole('switch', { name: analyticsModuleLabels[key] })).toHaveAttribute('aria-checked', 'true');
    }
    expect(screen.getByRole('switch', { name: analyticsModuleLabels.trend })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('toggling a switch after "אפס לברירת מחדל" clears the pending-reset flag -- "שמירה" then saves the explicit array again', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({ role: 'professional_manager', visibleModules: ['trend'] });
    await user.click(screen.getByRole('button', { name: 'אפס לברירת מחדל' }));
    await user.click(screen.getByRole('switch', { name: analyticsModuleLabels.trend }));
    await user.click(screen.getByRole('button', { name: 'שמירה' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalledWith(null);
  });

  it('"ביטול" discards any draft changes and closes without ever calling onSave', async () => {
    const user = userEvent.setup();
    const { onClose, onSave } = renderDialog({ visibleModules: [] });
    await user.click(screen.getByRole('switch', { name: analyticsModuleLabels.trend }));
    await user.click(screen.getByRole('button', { name: 'ביטול' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reopening starts fresh from the currently-effective modules, not a stale earlier draft', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(
      <AnalyticsViewSettingsDialog
        open
        onClose={() => {}}
        role="shift_supervisor"
        visibleModules={['trend']}
        onSave={onSave}
        saving={false}
      />,
    );
    await user.click(screen.getByRole('switch', { name: analyticsModuleLabels.closures }));

    // Close, then reopen: the abandoned draft (closures now checked) must
    // not leak into the next open.
    rerender(
      <AnalyticsViewSettingsDialog
        open={false}
        onClose={() => {}}
        role="shift_supervisor"
        visibleModules={['trend']}
        onSave={onSave}
        saving={false}
      />,
    );
    rerender(
      <AnalyticsViewSettingsDialog
        open
        onClose={() => {}}
        role="shift_supervisor"
        visibleModules={['trend']}
        onSave={onSave}
        saving={false}
      />,
    );
    expect(screen.getByRole('switch', { name: analyticsModuleLabels.closures })).toHaveAttribute('aria-checked', 'false');
  });

  it('disables every action button while saving', () => {
    renderDialog({ saving: true });
    expect(screen.getByRole('button', { name: 'אפס לברירת מחדל' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ביטול' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'שמירה' })).toBeDisabled();
  });
});
