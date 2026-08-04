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
import { createPortal } from 'react-dom';

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

// ---------- Compact filter-bar sizing ----------
/** Shorter height and tighter padding than the default Input/Select sizing
 *  above, for the dense archive/incidents filter rows. Deliberately kept
 *  separate from `inputBase` (never changes it) so every ordinary create/
 *  edit form and dialog field elsewhere keeps its existing taller,
 *  full-width sizing untouched. */
export const filterFieldClass = 'min-h-9 px-2 py-1.5';
/** Same compact sizing, for a dropdown or trigger button that sits inside a
 *  fixed-column filter grid (see IncidentFilterBar/ArchivePage) rather than
 *  stretching across a whole flex row -- deliberately still `w-full` (the
 *  `inputBase` default): filling its own grid cell is exactly the desired
 *  width, and a grid cell is a reliable way to get that instead of trying
 *  to win a `w-full`/`w-auto` cascade-order conflict on the same element. */
export const filterControlClass = filterFieldClass;

/**
 * A reliable `<input type="datetime-local">` for manual keyboard editing --
 * regular number row and numeric keypad alike.
 *
 * Native datetime-local inputs corrupt manual editing when kept fully
 * controlled (`value` + `onChange` feeding straight back into `value`, the
 * obvious React pattern): every keystroke on an already-complete value
 * re-fires `onChange` -> `setState` -> re-render, which reassigns the DOM
 * node's `.value` property. Browsers reset the control's active/focused
 * segment back to the first one (typically month) whenever `.value` is
 * programmatically reassigned -- even to a byte-for-byte identical string --
 * so the very next keystroke lands on whatever segment is now focused
 * instead of the one the user is actually editing. That reads as the month
 * "resetting, jumping, or becoming corrupted," but it isn't month-specific:
 * editing ANY segment retriggers the same reassignment and the same
 * refocus-to-first-segment.
 *
 * Fix: never hand `value` back to the DOM node once it exists. The input
 * stays uncontrolled after mount (`defaultValue` only); `onChange` still
 * reports every COMPLETE edit to the caller, for validation/duration/
 * submission, but the DOM node itself is never reassigned, so the browser's
 * own segment/focus state is never disturbed.
 *
 * A caller-driven reset (dialog opens and defaults to "now", a rejected
 * submission restores the previous value, etc.) is the one case that SHOULD
 * visibly jump the field -- comparing the incoming `value` against what this
 * component itself last reported distinguishes "the user typed this"
 * (already in sync, left alone) from "the caller changed this out from under
 * us" (remounted via `key`, the only way to hand a native datetime-local a
 * new value without repeating the exact bug this exists to avoid).
 */
export const DateTimeLocalInput = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
  } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'type' | 'dir'>
>(function DateTimeLocalInput({ value, onChange, className, ...rest }, ref) {
  const [trackedValue, setTrackedValue] = useState(value);
  const [resetToken, setResetToken] = useState(0);
  if (value !== trackedValue) {
    setTrackedValue(value);
    setResetToken((t) => t + 1);
  }
  return (
    <Input
      {...rest}
      key={resetToken}
      ref={ref}
      defaultValue={value}
      type="datetime-local"
      // datetime-local always lays out day/month/year and hour/minute
      // left-to-right, regardless of page language -- inheriting the
      // surrounding RTL document direction visually reverses the segment
      // order, which reads as broken even when nothing is wrong.
      dir="ltr"
      className={cx('text-left', className)}
      onChange={(e) => {
        // datetime-local's value is atomic: it is either a complete valid
        // string or "" while some segment is still mid-edit -- there is no
        // partial-but-valid state to speak of. Committing that intermediate
        // "" up to the caller (and therefore back into `value` above) is
        // exactly what used to wipe out whatever the user had already typed
        // elsewhere in the field, so it's ignored here.
        if (!e.target.value) return;
        setTrackedValue(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
});

// ---------- Switch ----------
/** Real accessible on/off switch (role="switch", accurate aria-checked,
 *  keyboard-operable via the native <button>, app-wide focus-visible ring).
 *  Positions its thumb with logical flex justify-content (start/end), not a
 *  raw transform, so it renders correctly under both RTL and LTR without
 *  mirrored-math bugs. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cx(
        'flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        checked ? 'justify-end bg-brand-600 dark:bg-brand-500' : 'justify-start bg-surface-active',
      )}
    >
      <span aria-hidden className="size-5 rounded-full bg-white shadow transition-transform" />
    </button>
  );
}

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
  color?: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'brand' | 'neutral';
  children: ReactNode;
  className?: string;
}) {
  const colors = {
    red: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200 border border-red-200 dark:border-red-800',
    orange:
      'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200 border border-orange-200 dark:border-orange-800',
    // Restrained yellow/gold -- medium severity's own identity, distinct
    // from high's orange and never neon/glowing: same restrained
    // bg-100/text-900 (light) and bg-950/text-200 (dark) pairing as every
    // other severity color, just a different hue.
    yellow:
      'bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200 border border-yellow-200 dark:border-yellow-800',
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
  return createPortal(
    <div
      // Rendered through a portal, not inline where the trigger happens to
      // live: a `fixed` element's containing block is normally the viewport,
      // but any ancestor with a `backdrop-filter` (e.g. the app header's
      // `backdrop-blur-sm`) or `filter`/`transform`/`contain` establishes its
      // own containing block for `fixed` descendants instead. Without the
      // portal, a dialog opened from inside that header collapses to the
      // header's own ~56px box -- which is exactly what pushed this dialog's
      // title/close button off-screen. `inset-0` on a `fixed` element (rather
      // than `h-[100vh]`) is what makes it track iOS Safari's dynamic
      // (chrome-collapsing) viewport correctly, so browser-chrome changes are
      // already handled by keeping this as `fixed inset-0`.
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-black/50 [padding:env(safe-area-inset-top)_0px_env(safe-area-inset-bottom)_0px] sm:items-center sm:[padding:calc(env(safe-area-inset-top)+1rem)_1rem_calc(env(safe-area-inset-bottom)+1rem)_1rem]"
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
          // `max-h-full` (not a fixed `dvh` number) caps the panel to the
          // overlay's own content box, which the safe-area padding above has
          // already shrunk -- so the panel can never render under the notch
          // or home-indicator without hardcoding two numbers that would have
          // to agree.
          'flex max-h-full w-full flex-col animate-scale-in overflow-hidden rounded-t-2xl border border-hairline bg-surface shadow-elevated sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 p-4 pb-3">
          <h2 className="section-title">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירת החלון"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Spinner / loading ----------
export function Spinner({ label = 'טוען…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={`flex items-center justify-center gap-2 py-8 ${className ?? 'text-muted'}`}>
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
