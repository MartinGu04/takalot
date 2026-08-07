// "התאמת התצוגה" -- lets an eligible role (shift_supervisor+, see
// canPersonalizeAnalytics) choose which of the six personalizable ניתוחים
// modules they see. The KPI row and the filter bar are never
// personalizable (see analyticsPreferences.ts's header for why).
//
// Draft-then-commit, the same pattern as the mobile filter sheet: toggling
// a switch (or clicking "אפס לברירת מחדל") only changes a local draft,
// applied on "שמירה" or discarded entirely if the dialog is closed/
// cancelled without saving. "אפס לברירת מחדל" resets the draft to this
// role's starting set (defaultAnalyticsModules) and arms a `pendingReset`
// flag; if "שמירה" is then clicked with the draft still untouched since,
// the save sends `null` (not the literal array) -- matching
// set_my_analytics_visible_modules's own "null means delete the stored row
// and fall back to the role default" contract (migration 0052), rather
// than locking today's default array in as a permanent stored preference.
// Toggling any individual switch after a reset clears `pendingReset`, since
// the draft is then an explicit choice again, not "the default."
import { useEffect, useState } from 'react';
import { ANALYTICS_MODULE_KEYS, defaultAnalyticsModules, type AnalyticsModuleKey } from '../../domain/analyticsPreferences';
import { analyticsModuleLabels } from '../../domain/labels';
import type { Role } from '../../domain/types';
import { Button, Dialog, Switch } from '../ui';

export function AnalyticsViewSettingsDialog({
  open,
  onClose,
  role,
  visibleModules,
  onSave,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  role: Role;
  /** The currently EFFECTIVE set (stored preference, or the role default
   *  when nothing is stored) -- what the dialog should show as already
   *  checked when it opens. */
  visibleModules: AnalyticsModuleKey[];
  onSave: (modules: AnalyticsModuleKey[] | null) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<Set<AnalyticsModuleKey>>(new Set(visibleModules));
  const [pendingReset, setPendingReset] = useState(false);

  // The dialog always starts from the currently-effective modules, never a
  // stale earlier draft (e.g. from a previous open that was cancelled).
  useEffect(() => {
    if (open) {
      setDraft(new Set(visibleModules));
      setPendingReset(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggle(key: AnalyticsModuleKey) {
    setPendingReset(false);
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleReset() {
    setDraft(new Set(defaultAnalyticsModules(role)));
    setPendingReset(true);
  }

  function handleSave() {
    onSave(pendingReset ? null : [...draft]);
  }

  return (
    <Dialog open={open} onClose={onClose} title="התאמת התצוגה">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          בחרו אילו מודולים יוצגו בעמוד הניתוחים עבורכם. שורת המדדים העליונה וסרגל הסינון מוצגים תמיד, לכל המשתמשים.
        </p>
        <div className="flex flex-col divide-y divide-hairline">
          {ANALYTICS_MODULE_KEYS.map((key) => (
            <div key={key} className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-sm font-medium text-text-primary">{analyticsModuleLabels[key]}</span>
              <Switch checked={draft.has(key)} onChange={() => toggle(key)} label={analyticsModuleLabels[key]} />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-hairline pt-3">
          <Button variant="ghost" onClick={handleReset} disabled={saving}>
            אפס לברירת מחדל
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              ביטול
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              שמירה
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
