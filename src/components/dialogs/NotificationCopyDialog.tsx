import { useState } from 'react';
import { Button, Dialog } from '../ui';

const SUPPORTING_TEXT =
  'כרגע AVARIA עדיין לא שולחת התראות אוטומטיות לוואטסאפ. יש להעתיק את ההודעה ולשלוח בקבוצת התקלות.';

/**
 * Temporary operational-solution modal (no real WhatsApp integration yet):
 * shown once, right after an incident create/close request is confirmed by
 * the server, prompting the acting user to copy a prepared message and send
 * it manually to the incidents WhatsApp group. The app can only verify that
 * the copy itself succeeded -- never that the message was pasted or sent.
 */
export function NotificationCopyDialog({
  open,
  title,
  message,
  onDismiss,
}: {
  open: boolean;
  title: string;
  message: string;
  onDismiss: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleClose = () => {
    setCopyState('idle');
    onDismiss();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} title={title}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{SUPPORTING_TEXT}</p>

        <div role="group" aria-label="תוכן ההודעה להעתקה" className="rounded-lg border border-hairline-strong bg-surface-hover p-3">
          <p dir="auto" tabIndex={0} className="select-all whitespace-pre-wrap break-words text-sm font-medium text-text-primary">
            {message}
          </p>
        </div>

        <div aria-live="polite" className="sr-only">
          {copyState === 'copied' && 'ההודעה הועתקה ללוח.'}
          {copyState === 'failed' && 'העתקת ההודעה נכשלה.'}
        </div>

        {copyState === 'failed' && (
          <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            ההעתקה האוטומטית נכשלה. ניתן לסמן את ההודעה למעלה ולהעתיק אותה ידנית.
          </p>
        )}

        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={handleClose}>
            המשך ללא העתקה
          </Button>
          <Button
            type="button"
            variant={copyState === 'copied' ? 'secondary' : 'primary'}
            onClick={() => void handleCopy()}
          >
            {copyState === 'copied' ? 'הועתקה ✓' : 'העתקת הודעה'}
          </Button>
          <Button
            type="button"
            variant={copyState === 'copied' ? 'primary' : 'secondary'}
            disabled={copyState !== 'copied'}
            onClick={handleClose}
          >
            סיום
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
