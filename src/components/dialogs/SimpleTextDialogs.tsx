import { useState } from 'react';
import { Dialog, Field, Textarea, Button } from '../ui';

export function CorrectionDialog({
  open,
  onClose,
  refLabel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  refLabel: string;
  onSubmit: (text: string) => void;
  submitting: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const handleClose = () => {
    setText('');
    setError(undefined);
    onClose();
  };
  return (
    <Dialog open={open} onClose={handleClose} title="תיקון רישום">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) {
            setError('יש להזין תוכן לתיקון');
            return;
          }
          onSubmit(text.trim());
        }}
      >
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          מתקן: <strong>{refLabel}</strong>. הרישום המקורי יישאר בציר הזמן, והתיקון יתווסף כאירוע נפרד.
        </p>
        <Field label="תוכן התיקון" required error={error}>
          {(a) => <Textarea {...a} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
          <Button type="submit" disabled={submitting}>{submitting ? 'שומר…' : 'שמירת תיקון'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function FollowUpDialog({
  open,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
  submitting: boolean;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const handleClose = () => {
    setNote('');
    setError(undefined);
    onClose();
  };
  return (
    <Dialog open={open} onClose={handleClose} title="השלמת פעולות המשך">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) {
            setError('יש לפרט מה בוצע');
            return;
          }
          onSubmit(note.trim());
        }}
      >
        <Field label="מה בוצע להשלמת הכשירות המלאה" required error={error}>
          {(a) => <Textarea {...a} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>ביטול</Button>
          <Button type="submit" disabled={submitting}>{submitting ? 'שומר…' : 'סימון כהושלם'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
