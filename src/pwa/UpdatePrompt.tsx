// Compact, user-controlled "new version available" notice. Never reloads on
// its own -- only in direct response to the user choosing "עדכון עכשיו" (see
// usePwaUpdate) -- so a page never disappears out from under someone mid-way
// through opening, updating, or closing an incident.
import { Button } from '../components/ui';
import { usePwaUpdate } from './usePwaUpdate';

export function UpdatePrompt() {
  const { needRefresh, update, dismiss } = usePwaUpdate();
  if (!needRefresh) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex justify-center px-4 pb-[env(safe-area-inset-bottom)] sm:bottom-6"
    >
      <div className="pointer-events-auto w-full max-w-sm animate-scale-in rounded-xl border border-hairline bg-surface p-4 shadow-elevated">
        <p className="text-sm font-bold text-text-primary">גרסה חדשה של AVARIA זמינה</p>
        <p className="mt-1 text-sm text-text-secondary">כדי לקבל את השינויים האחרונים יש לרענן את המערכת.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={dismiss}>
            מאוחר יותר
          </Button>
          <Button variant="primary" onClick={update}>
            עדכון עכשיו
          </Button>
        </div>
      </div>
    </div>
  );
}
