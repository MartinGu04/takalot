// Small accessible UI kit, RTL-first, light/dark aware.
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- Button ----------
type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'success'
  | 'info'
  | 'warning'
  | 'danger'
  | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300 dark:bg-brand-500 dark:hover:bg-brand-400 dark:disabled:bg-brand-900',
  secondary:
    'bg-surface text-text-primary border border-hairline-strong shadow-soft hover:bg-surface-hover',
  accent:
    'border border-brand-300 bg-brand-50 text-brand-900 shadow-soft hover:bg-brand-100 disabled:opacity-50 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-200 dark:hover:bg-brand-900/60',
  success:
    'border border-green-300 bg-green-50 text-green-900 shadow-soft hover:bg-green-100 disabled:opacity-50 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200 dark:hover:bg-green-900/60',
  // Muted indigo, deliberately built to the same shape as `accent`/`success`
  // (tinted surface + matching border, never a filled/solid fill): a
  // secondary action that needs to read as its own category without ever
  // competing with the single primary action on the screen.
  info:
    'border border-indigo-300 bg-indigo-50 text-indigo-900 shadow-soft hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200 dark:hover:bg-indigo-900/60',
  warning:
    'border border-amber-300 bg-amber-50 text-amber-950 shadow-soft hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-900/60',
  danger:
    'bg-red-700 text-white hover:bg-red-800 disabled:bg-red-300 dark:bg-red-600 dark:hover:bg-red-500',
  ghost:
    'text-text-secondary hover:bg-surface-hover',
};

export function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100',
        buttonStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

// ---------- Form fields ----------
const inputBase =
  'w-full min-h-11 rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 aria-[invalid=true]:border-red-500';

// forwardRef is required here: react-hook-form's register() attaches a ref to
// read the DOM value at submit time, which is silently lost on plain function
// components (React warns but does not throw, so this fails only at runtime).
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} {...props} className={cx(inputBase, props.className)} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ rows = 3, ...props }, ref) {
    return <textarea ref={ref} rows={rows} {...props} className={cx(inputBase, 'min-h-20', props.className)} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(props, ref) {
    return <select ref={ref} {...props} className={cx(inputBase, props.className)} />;
  },
);

/** Labeled field with semantic error message. */
export function Field({
  label,
  error,
  required,
  hint,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  hint?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-text-primary">
        {label}
        {required && <span className="text-red-600 dark:text-red-400"> *</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': error ? errorId : undefined })}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------- Badge ----------
export function Badge({
  color = 'neutral',
  children,
  className,
}: {
  color?: 'red' | 'orange' | 'green' | 'blue' | 'brand' | 'neutral';
  children: ReactNode;
  className?: string;
}) {
  const colors = {
    red: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200 border border-red-200 dark:border-red-800',
    orange:
      'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200 border border-orange-200 dark:border-orange-800',
    green:
      'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200 border border-green-200 dark:border-green-800',
    blue: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200 border border-blue-200 dark:border-blue-800',
    brand:
      'bg-brand-100 text-brand-900 dark:bg-brand-950 dark:text-brand-200 border border-brand-200 dark:border-brand-800',
    neutral: 'bg-surface-active text-text-secondary border border-hairline',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium',
        colors[color],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------- Truncated text with a tooltip ----------
/**
 * Single-line text that truncates to its container, without the full value
 * becoming unreachable. The visible text stays truncated; the complete value
 * is exposed two ways at once:
 *
 *  - programmatically, via `aria-describedby` -> a `role="tooltip"` node that
 *    is in the accessibility tree at all times (so a screen reader announces
 *    the whole string regardless of hover/focus), and
 *  - visually, revealed on BOTH pointer hover and keyboard focus.
 *
 * The keyboard half is why this exists rather than a plain `title=`
 * attribute: browsers render `title` only on hover, so a keyboard user
 * tabbing through the interface can never surface it. The trigger is
 * therefore focusable (`tabIndex={0}`), which is what makes the reveal
 * reachable without a pointer.
 *
 * Reveal is pure CSS (`group-hover` / `group-focus-within`) -- no state, no
 * effects, and nothing to get stuck open if the element unmounts mid-hover.
 */
export function TruncatedTooltip({
  text,
  className,
  tooltipClassName,
}: {
  text: string;
  className?: string;
  tooltipClassName?: string;
}) {
  const id = useId();
  return (
    <span className="group/tooltip relative block min-w-0">
      <span tabIndex={0} aria-describedby={id} className={cx('block truncate rounded-sm', className)}>
        {text}
      </span>
      <span
        role="tooltip"
        id={id}
        // dir="auto" so a Latin or mixed-script value is laid out by its own
        // first strong character rather than inheriting the RTL page
        // direction, which would strand its punctuation on the wrong side.
        dir="auto"
        className={cx(
          'pointer-events-none absolute bottom-full z-50 mb-1.5 hidden w-max max-w-56 rounded-lg border border-hairline bg-surface px-2 py-1 text-xs font-medium text-text-primary opacity-0 shadow-elevated transition-opacity group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 md:block',
          tooltipClassName,
        )}
      >
        {text}
      </span>
    </span>
  );
}

// ---------- Avatar ----------
/**
 * The signed-in person's avatar: their provider profile image when one is
 * available, and the long-standing initial otherwise.
 *
 * The initial is ALWAYS rendered and the image is layered over it, absolutely
 * positioned inside the same fixed-size box. That gives three things for free:
 * the box never changes size, so nothing around it can shift; a slow image
 * shows the initial rather than a blank or broken frame while it loads; and a
 * URL that fails to load (expired Google link, offline, blocked host) simply
 * uncovers the initial again via onError.
 *
 * `className` carries the caller's existing size/shape/colour classes verbatim
 * so each call site keeps the exact avatar it had before.
 */
export function Avatar({
  src,
  name,
  className,
  imgClassName,
  ...rest
}: {
  src?: string | null;
  name: string;
  className?: string;
  imgClassName?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'children'>) {
  const [failed, setFailed] = useState(false);
  // A different URL deserves a fresh attempt -- otherwise one failure would
  // permanently suppress the image for the rest of the session.
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const showImage = !!src && !failed;
  return (
    <span className={cx('relative overflow-hidden', className)} {...rest}>
      {name.charAt(0)}
      {showImage && (
        <img
          src={src}
          alt=""
          // Google's avatar host rejects some cross-origin referrers; sending
          // none keeps the image working without any additional permission.
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className={cx('absolute inset-0 size-full object-cover', imgClassName)}
        />
      )}
    </span>
  );
}

// ---------- Dialog ----------
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read the latest onClose without making the effect below depend on its
  // identity — onClose is typically a fresh closure on every render of the
  // dialog's content (e.g. a handleClose defined inline in the caller), and
  // depending on it directly would re-run this effect on every keystroke
  // inside the dialog, re-focusing the first focusable element (the dialog's
  // own close button, which is rendered before the form content) and
  // yanking focus away from whatever field the user is actively typing in.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      // Trap Tab focus inside the dialog so it never leaks to the page behind it.
      if (e.key === 'Tab') {
        const items = focusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const activeIndex = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && (activeIndex === 0 || activeIndex === -1)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && activeIndex === items.length - 1) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // Move focus into the dialog once, when it opens — not on every
    // re-render triggered by typing in its fields.
    focusable()[0]?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          // A flex COLUMN with a capped height, not a plain block with
          // overflow-y-auto directly on it: the header below must stay put
          // while only the body scrolls. `min-h-0` on the body is the part
          // that actually matters -- a flex item's default min-height is
          // `auto`, which lets it refuse to shrink below its own content
          // size and silently defeats `flex-1`/overflow further down,
          // letting content quietly grow the whole panel past max-height
          // instead of scrolling inside it. `overflow-hidden` here (rather
          // than `-auto`) is deliberate: this outer panel itself never
          // scrolls -- only the body below does -- and it also keeps the
          // scrolling body's content clipped to the panel's rounded corners.
          'flex max-h-[92dvh] w-full flex-col animate-scale-in overflow-hidden rounded-t-2xl border border-hairline bg-surface shadow-elevated sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 p-4 pb-3">
          <h2 className="section-title">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירת החלון"
            className="rounded-lg p-2 text-muted hover:bg-surface-hover"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------- Spinner / loading ----------
export function Spinner({ label = 'טוען…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-8 text-muted">
      <span className="inline-block size-5 animate-spin rounded-full border-2 border-hairline-strong border-t-brand-600 dark:border-t-brand-400" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

// ---------- Empty / error states ----------
export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-hairline-strong bg-surface/60 py-10 text-center">
      <p className="font-medium text-text-secondary">{title}</p>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 p-4 text-center dark:border-red-900 dark:bg-red-950"
    >
      <p className="text-sm font-medium text-red-800 dark:text-red-200">{message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          ניסיון חוזר
        </Button>
      )}
    </div>
  );
}

// ---------- Toasts ----------
interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error';
  action?: { label: string; onClick: () => void };
}

const ToastContext = createContext<{
  toast: (text: string, kind?: 'success' | 'error', action?: Toast['action']) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const toast = useCallback(
    (text: string, kind: 'success' | 'error' = 'success', action?: Toast['action']) => {
      const id = ++idRef.current;
      setToasts((t) => [...t, { id, text, kind, action }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000);
    },
    [],
  );
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm shadow-lg',
              t.kind === 'error'
                ? 'bg-red-700 text-white'
                : 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900',
            )}
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="shrink-0 font-bold underline"
                onClick={t.action.onClick}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx.toast;
}
