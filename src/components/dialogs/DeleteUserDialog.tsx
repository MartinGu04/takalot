// Permanent user deletion: a distinct, deliberately heavier confirmation
// flow than deactivation (ConfirmDialog). Deletion is not reversible
// through the normal personnel-management flow, unlike deactivation --
// this dialog exists specifically to make that difference unmistakable,
// and to require a typed confirmation rather than a single click.
import { useState } from 'react';
import type { PersonnelEntry } from '../../domain/types';
import { personnelRoleLabels } from '../../domain/labels';
import { Dialog, Field, Input, Button, Badge } from '../ui';

export function DeleteUserDialog({
  entry,
  onClose,
  submitting,
  onConfirm,
}: {
  entry: PersonnelEntry | null;
  onClose: () => void;
  submitting?: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const open = !!entry;
  const expected = entry?.fullName ?? '';
  const matches = typed.trim() === expected.trim() && expected.trim().length > 0;

  const handleClose = () => {
    setTyped('');
    onClose();
  };

  if (!entry) return null;
  return (
    <Dialog open={open} onClose={handleClose} title="מחיקת משתמש לצמיתות">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{entry.fullName}</span>
          <Badge color="neutral">{personnelRoleLabels[entry.role]}</Badge>
        </div>

        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">פעולה בלתי הפיכה — לא ניתן לבטל אותה דרך ניהול כוח אדם הרגיל.</p>
          <ul className="mt-2 list-inside list-disc space-y-1">
            <li>חשבון ההתחברות הנוכחי של המשתמש ל-AVARIA יימחק מ-Supabase Auth.</li>
            <li>רישום איש הצוות ב-AVARIA יסומן לצמיתות כ"נמחק", יישאר קיים לצמיתות (כולל שם ותפקיד) ולא ניתן יהיה להשתמש בו מחדש.</li>
            <li>
              תקלות, עדכונים, אירועים, התראות ורישומי ביקורת שהמשתמש היה מעורב בהם{' '}
              <span className="font-semibold">לא</span> יימחקו — הם יישארו כרשומה היסטורית, כולל שיוך שמו.
            </li>
            <li>פעולה זו אינה מוחקת את חשבון ה-Google החיצוני של האדם — היא מסירה רק את הגישה שלו ל-AVARIA.</li>
          </ul>
        </div>

        <Field label={`להמשך, יש להקליד את השם המדויק: "${expected}"`} required>
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
            onClick={onConfirm}
          >
            {submitting ? 'מוחק…' : 'מחיקה לצמיתות'}
          </Button>
          <Button type="button" variant="secondary" onClick={handleClose}>
            ביטול
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
