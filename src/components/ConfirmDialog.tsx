// Generic confirmation dialog for destructive or consequential actions
// (cancellation, deactivation, role changes) -- reuses Dialog, which is a
// bottom sheet on mobile and a centered dialog on desktop.
import type { ReactNode } from 'react';
import { Dialog, Button } from './ui';

export function ConfirmDialog({
  open,
  onClose,
  title,
  message,
  confirmLabel = 'אישור',
  cancelLabel = 'ביטול',
  danger,
  submitting,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  submitting?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        <div className="text-sm text-secondary">{message}</div>
        <div className="flex justify-end gap-2">
          {/* RTL: first in source order sits rightmost -- the primary
              (confirm) action goes first so it reads as visually first. */}
          <Button type="button" variant={danger ? 'danger' : 'primary'} disabled={submitting} onClick={onConfirm}>
            {submitting ? 'שומר…' : confirmLabel}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
