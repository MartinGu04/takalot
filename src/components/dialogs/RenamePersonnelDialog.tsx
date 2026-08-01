// שינוי שם -- a small, focused dialog for correcting a personnel entry's
// display name. Used for pending entries and already-linked profiles
// (active or inactive) alike; the caller decides which repository method
// to call based on the entry's kind. Authorization is enforced server-side
// (the same role ceilings as every other personnel action) -- this dialog
// only offers the matching UX.
import { useState } from 'react';
import { renamePersonnelInputSchema } from '../../domain/schemas';
import { Dialog, Field, Input, Button } from '../ui';

const MAX_LENGTH = 60;

export function RenamePersonnelDialog({
  open,
  currentName,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  currentName: string;
  onClose: () => void;
  onSubmit: (fullName: string) => void;
  submitting: boolean;
}) {
  const [fullName, setFullName] = useState(currentName);
  const [error, setError] = useState<string | undefined>();

  const handleClose = () => {
    setFullName(currentName);
    setError(undefined);
    onClose();
  };

  const submit = () => {
    const parsed = renamePersonnelInputSchema.safeParse({ fullName });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'קלט לא תקין');
      return;
    }
    setError(undefined);
    onSubmit(parsed.data.fullName);
  };

  if (!open) return null;
  return (
    <Dialog open={open} onClose={handleClose} title="שינוי שם">
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="שם מלא" required error={error}>
          {(a) => (
            <Input
              {...a}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              maxLength={MAX_LENGTH}
              autoFocus
            />
          )}
        </Field>
        <p className="text-xs text-muted" aria-live="polite">
          {fullName.trim().length}/{MAX_LENGTH} תווים
        </p>
        <div className="flex justify-end gap-2 pt-2">
          {/* RTL: the first element in source order sits rightmost -- the
              primary "שמירה" action goes first so it reads as visually
              first. */}
          <Button type="submit" disabled={submitting}>
            {submitting ? 'שומר…' : 'שמירה'}
          </Button>
          <Button type="button" variant="secondary" onClick={handleClose}>
            ביטול
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
