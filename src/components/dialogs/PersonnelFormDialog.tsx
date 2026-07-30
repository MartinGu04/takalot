// Add / edit a pending-personnel entry. Opens as a bottom sheet on mobile
// and a dialog on desktop (via the shared Dialog component). Only shows
// role options the signed-in creator's ceiling allows -- the database is
// the real enforcement boundary; this is only the matching UX.
import { useState } from 'react';
import type { Role } from '../../domain/types';
import { pendingPersonnelInputSchema, type PendingPersonnelInput } from '../../domain/schemas';
import { personnelRoleLabels } from '../../domain/labels';
import { Dialog, Field, Input, Select, Button } from '../ui';

export function PersonnelFormDialog({
  open,
  onClose,
  title,
  submitLabel,
  initial,
  allowedRoles,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  submitLabel: string;
  initial?: { fullName: string; email: string; role: Role };
  allowedRoles: Role[];
  onSubmit: (input: PendingPersonnelInput) => void;
  submitting: boolean;
}) {
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [role, setRole] = useState<Role>(initial?.role ?? allowedRoles[0] ?? 'technician');
  const [error, setError] = useState<string | undefined>();

  const handleClose = () => {
    setFullName(initial?.fullName ?? '');
    setEmail(initial?.email ?? '');
    setRole(initial?.role ?? allowedRoles[0] ?? 'technician');
    setError(undefined);
    onClose();
  };

  const submit = () => {
    const parsed = pendingPersonnelInputSchema.safeParse({ fullName, email, role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'קלט לא תקין');
      return;
    }
    setError(undefined);
    onSubmit(parsed.data);
  };

  // The current role of an entry being edited might sit above the editor's
  // ceiling in theory; in practice the edit action is only offered when it
  // doesn't, but include it defensively so the select never silently drops
  // the entry's own role.
  const roleOptions = initial && !allowedRoles.includes(initial.role) ? [initial.role, ...allowedRoles] : allowedRoles;

  if (!open) return null;
  return (
    <Dialog open={open} onClose={handleClose} title={title}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="שם מלא" required>
          {(a) => <Input {...a} value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} autoFocus />}
        </Field>
        <Field label="כתובת חשבון Google" required hint="הכתובת שאיתה איש הצוות יתחבר ל-AVARIA">
          {(a) => (
            <Input
              {...a}
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={320}
              placeholder="name@example.com"
            />
          )}
        </Field>
        <Field label="תפקיד" required>
          {(a) => (
            <Select {...a} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {personnelRoleLabels[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {error && (
          <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          {/* RTL: the first element in source order sits rightmost -- the
              primary action goes first so it reads as visually first. */}
          <Button type="submit" disabled={submitting}>
            {submitting ? 'שומר…' : submitLabel}
          </Button>
          <Button type="button" variant="secondary" onClick={handleClose}>
            ביטול
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
