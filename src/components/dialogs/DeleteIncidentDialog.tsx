// Permanent incident deletion: modeled directly on DeleteUserDialog's
// visual/interaction pattern -- a distinct, deliberately heavier
// confirmation flow than any other incident action. Two layered steps:
// (1) a strong warning + typed-exact-number gate before the destructive
// button even becomes clickable, (2) a final explicit ConfirmDialog before
// the mutation is ever actually called. No deletion-reason field, matching
// the approved product decision -- this is an exceptional purge, not a
// lifecycle action that needs a justification on record.
import { useState } from 'react';
import type { Incident } from '../../domain/types';
import { Dialog, Field, Input, Button } from '../ui';
import { ConfirmDialog } from '../ConfirmDialog';

export function DeleteIncidentDialog({
  incident,
  onClose,
  submitting,
  onConfirm,
}: {
  incident: Incident | null;
  onClose: () => void;
  submitting?: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [finalConfirmOpen, setFinalConfirmOpen] = useState(false);
  const open = !!incident;
  const expected = incident?.number ?? '';
  const matches = typed.trim() === expected.trim() && expected.trim().length > 0;

  const handleClose = () => {
    setTyped('');
    setFinalConfirmOpen(false);
    onClose();
  };

  if (!incident) return null;
  return (
    <>
      <Dialog open={open && !finalConfirmOpen} onClose={handleClose} title="מחיקת תקלה לצמיתות">
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            <p className="font-semibold">פעולה בלתי הפיכה — לא ניתן לבטל אותה.</p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              <li>תקלה {incident.number} תימחק לצמיתות מ-AVARIA, כולל כל המידע התפעולי שלה (עדכונים, ציר זמן, סיווגים, דיווחים, התראות).</li>
              <li>קישורים לתקלות קשורות אחרות יוסרו גם הם.</li>
              <li>רישומי ביקורת היסטוריים על תקלה זו יישארו קיימים לצמיתות ביומן הביקורת.</li>
            </ul>
          </div>

          <Field label={`להמשך, יש להקליד את מספר התקלה המדויק: "${expected}"`} required>
            {(a) => (
              <Input
                {...a}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoFocus
                placeholder={expected}
              />
            )}
          </Field>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={!matches || submitting}
              onClick={() => setFinalConfirmOpen(true)}
            >
              מחיקה לצמיתות
            </Button>
            <Button type="button" variant="secondary" onClick={handleClose}>
              ביטול
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={finalConfirmOpen}
        onClose={() => setFinalConfirmOpen(false)}
        title="מחיקת תקלה לצמיתות"
        message={`למחוק לצמיתות את תקלה ${incident.number}?`}
        confirmLabel="מחיקה לצמיתות"
        danger
        submitting={submitting}
        onConfirm={onConfirm}
      />
    </>
  );
}
