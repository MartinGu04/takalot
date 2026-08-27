// AVARIA's short, contextual first-time setup experience -- see
// useOnboardingState for how "what to show right now" is decided. Reuses
// the existing Dialog (bottom sheet on mobile, centered modal on desktop --
// exactly the same component every other AVARIA dialog uses) rather than a
// bespoke wizard shell, and drives Push entirely through the existing
// usePushSubscription hook -- there is no second, parallel notification
// implementation here.
//
// Deliberately stays open (and its content live-updates) once shown for
// this mount, even after the underlying step reaches 'done' -- that is
// precisely what lets the short "AVARIA מוכנה לעבודה" confirmation appear
// right after finishing a step, instead of the modal vanishing the instant
// shouldShowModal itself would otherwise go false.
import { useEffect, useState } from 'react';
import { AvariaIcon } from '../components/AvariaBrand';
import { Button, Dialog } from '../components/ui';
import { useOnboardingState } from './useOnboardingState';
import type { OnboardingStep } from './onboardingStep';

function ProgressRow({ step, installed }: { step: OnboardingStep; installed: boolean }) {
  const notifDone = step === 'done';
  const installDone = installed || step !== 'install';
  return (
    <div className="mb-4 flex items-center gap-2 text-xs font-medium text-muted" aria-hidden>
      <span className={installDone ? 'text-brand-700 dark:text-brand-400' : step === 'install' ? 'text-text-primary' : ''}>
        {installDone ? '✅' : '📱'} התקנת AVARIA
      </span>
      <span className="h-px flex-1 bg-hairline" />
      <span className={notifDone ? 'text-brand-700 dark:text-brand-400' : step === 'notifications' ? 'text-text-primary' : ''}>
        {notifDone ? '✅' : '🔔'} הפעלת התראות
      </span>
    </div>
  );
}

function InstallStep({
  isIOS,
  canPromptInstall,
  promptInstall,
  onPostpone,
}: {
  isIOS: boolean;
  canPromptInstall: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  onPostpone: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  if (isIOS) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">
          AVARIA עובדת הכי טוב כשהיא מותקנת כאפליקציה במסך הבית. ב-Safari:
        </p>
        <ol className="flex flex-col gap-2 text-sm text-text-primary">
          <li className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200">1</span>
            יש להקיש על כפתור <strong>שיתוף</strong> בשורת הכתובת
          </li>
          <li className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200">2</span>
            לבחור <strong>הוסף למסך הבית</strong>
          </li>
          <li className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 dark:bg-brand-950 dark:text-brand-200">3</span>
            להקיש <strong>הוספה</strong>
          </li>
        </ol>
        <p className="text-xs text-muted">לאחר ההתקנה יש לפתוח את AVARIA מהסמל שנוסף למסך הבית כדי להמשיך.</p>
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" onClick={onPostpone}>אחר כך</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">
        התקנה הופכת את AVARIA לאפליקציה עצמאית במכשיר, עם גישה מהירה וגם התראות.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onPostpone}>אחר כך</Button>
        <Button
          disabled={!canPromptInstall || installing}
          onClick={async () => {
            setInstalling(true);
            try {
              await promptInstall();
            } finally {
              setInstalling(false);
            }
          }}
        >
          {installing ? 'מתקין…' : 'התקן את AVARIA'}
        </Button>
      </div>
    </div>
  );
}

function NotificationsStep({
  permissionDenied,
  enabling,
  onEnable,
  onPostpone,
}: {
  permissionDenied: boolean;
  enabling: boolean;
  onEnable: () => void;
  onPostpone: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-text-primary">נשאר עוד דבר אחד</p>
      {permissionDenied ? (
        <>
          <p className="text-sm text-text-secondary">
            התראות חסומות כרגע בדפדפן. ניתן לאפשר אותן דרך הגדרות האתר בדפדפן ולנסות שוב מאוחר יותר.
          </p>
          <div className="flex justify-end">
            <Button onClick={onPostpone}>המשך</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            התראות מאפשרות ל-AVARIA להתריע לך על פעילות תקלות רלוונטית, גם כשהאפליקציה סגורה.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onPostpone}>אחר כך</Button>
            <Button disabled={enabling} onClick={onEnable}>
              {enabling ? 'מפעיל…' : 'אפשר התראות'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CompletedStep({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <p className="text-lg font-bold text-text-primary">✅ AVARIA מוכנה לעבודה</p>
      <Button onClick={onClose}>כניסה ל-AVARIA</Button>
    </div>
  );
}

export function OnboardingModal() {
  const onboarding = useOnboardingState();
  const [open, setOpen] = useState(false);
  const [everShown, setEverShown] = useState(false);

  // Opens at most once per mount (per signed-in session on this device) --
  // never reopens itself mid-session just because some OTHER state
  // momentarily re-evaluates shouldShowModal, so a postponed/closed modal
  // never pops back up while the user keeps navigating the app.
  useEffect(() => {
    if (onboarding.shouldShowModal && !everShown) {
      setOpen(true);
      setEverShown(true);
    }
  }, [onboarding.shouldShowModal, everShown]);

  if (!open) return null;

  const postpone = () => {
    onboarding.dismiss();
    setOpen(false);
  };
  const close = () => setOpen(false);

  return (
    <Dialog open={open} onClose={postpone} title="ברוך הבא ל-AVARIA 👋">
      <div className="flex flex-col gap-1">
        <div className="mb-1 flex items-center gap-2">
          <AvariaIcon className="size-8 rounded-lg" />
          <p className="text-sm text-text-secondary">
            AVARIA עובדת הכי טוב כשהיא מותקנת כאפליקציה ומאפשרת התראות תפעוליות.
          </p>
        </div>
        <ProgressRow step={onboarding.step} installed={onboarding.installed} />
        {onboarding.step === 'install' && (
          <InstallStep
            isIOS={onboarding.isIOS}
            canPromptInstall={onboarding.canPromptInstall}
            promptInstall={onboarding.promptInstall}
            onPostpone={postpone}
          />
        )}
        {onboarding.step === 'notifications' && (
          <NotificationsStep
            permissionDenied={onboarding.push.state === 'permission-denied'}
            enabling={onboarding.push.state === 'loading'}
            onEnable={() => void onboarding.push.enable()}
            onPostpone={postpone}
          />
        )}
        {onboarding.step === 'done' && <CompletedStep onClose={close} />}
      </div>
    </Dialog>
  );
}
