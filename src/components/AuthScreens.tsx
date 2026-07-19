// Full-screen states that gate the app before normal routing: initial auth
// restoration (splash), authenticated-but-unauthorized, transient
// authorization-check failure, and hard configuration errors.
import { APP_NAME, APP_TAGLINE } from '../domain/labels';
import { NexusMark } from './NexusMark';
import { Button, Spinner } from './ui';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-6 text-center shadow-elevated sm:p-8">
        <div className="flex flex-col items-center gap-3">
          <NexusMark className="size-12" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-text-primary">{APP_NAME}</h1>
            <p className="mt-1 text-sm text-muted">{APP_TAGLINE}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Shown while the persisted session is being restored, INSTEAD of any
 *  route -- the login page must never flash for an already-signed-in user. */
export function AuthLoadingScreen() {
  return (
    <Shell>
      <div className="mt-6" data-testid="auth-loading">
        <Spinner label="בודק התחברות…" />
      </div>
    </Shell>
  );
}

/** Identity proven (Google), but no active authorized profile exists.
 *  Access is denied -- profiles are provisioned by an administrator only,
 *  never auto-created because a Google login succeeded. */
export function UnauthorizedScreen({
  email,
  onLogout,
}: {
  email: string | null;
  onLogout: () => void;
}) {
  return (
    <Shell>
      <div className="mt-6" data-testid="unauthorized-screen">
        <h2 className="text-lg font-bold text-text-primary">אין הרשאת גישה למערכת</h2>
        {email && (
          <p className="mt-2 text-sm text-secondary">
            מחובר/ת עם <span dir="ltr" className="font-medium">{email}</span>
          </p>
        )}
        <p className="mt-2 text-sm text-secondary">החשבון הזה אינו רשום בכוח האדם של Nexus.</p>
        <p className="mt-1 text-sm text-muted">יש לפנות לאחמ״ש, לנגד או למנהל המערכת.</p>
        <Button variant="secondary" className="mt-5 w-full" onClick={onLogout}>
          התנתקות
        </Button>
      </div>
    </Shell>
  );
}

/** The authorization check itself failed (network/database) -- retryable,
 *  and deliberately distinct from "unauthorized". */
export function AuthErrorScreen({ onRetry, onLogout }: { onRetry: () => void; onLogout: () => void }) {
  return (
    <Shell>
      <div className="mt-6" data-testid="auth-error-screen">
        <h2 className="text-lg font-bold text-text-primary">שגיאה בבדיקת ההרשאה</h2>
        <p className="mt-2 text-sm text-secondary">
          לא ניתן היה לאמת את ההרשאה מול השרת. ייתכן שמדובר בתקלת תקשורת זמנית.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Button onClick={onRetry}>ניסיון חוזר</Button>
          <Button variant="secondary" onClick={onLogout}>
            התנתקות
          </Button>
        </div>
      </div>
    </Shell>
  );
}

/** Hard configuration error (production build without Supabase config,
 *  partial config, or a server secret in a client variable). The app never
 *  silently falls back to demo data instead of showing this. */
export function ConfigErrorScreen({ reason }: { reason: string }) {
  return (
    <Shell>
      <div className="mt-6" data-testid="config-error-screen">
        <h2 className="text-lg font-bold text-red-700 dark:text-red-400">שגיאת תצורה</h2>
        <p className="mt-2 text-sm text-secondary">{reason}</p>
        <p className="mt-3 text-xs text-muted">
          המערכת אינה עולה ללא תצורה תקינה כדי למנוע הפעלה שגויה על נתוני הדגמה.
        </p>
      </div>
    </Shell>
  );
}
