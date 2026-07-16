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
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- Button ----------
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-700 text-white hover:bg-blue-800 disabled:bg-blue-300 dark:bg-blue-600 dark:hover:bg-blue-500 dark:disabled:bg-blue-900',
  secondary:
    'bg-white text-neutral-800 border border-neutral-300 hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700',
  danger:
    'bg-red-700 text-white hover:bg-red-800 disabled:bg-red-300 dark:bg-red-600 dark:hover:bg-red-500',
  ghost:
    'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800',
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
        'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed',
        buttonStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

// ---------- Form fields ----------
const inputBase =
  'w-full min-h-11 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 aria-[invalid=true]:border-red-500';

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
      <label htmlFor={id} className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        {label}
        {required && <span className="text-red-600 dark:text-red-400"> *</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': error ? errorId : undefined })}
      {hint && !error && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
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
  color?: 'red' | 'orange' | 'green' | 'blue' | 'neutral';
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
    neutral:
      'bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200 border border-neutral-200 dark:border-neutral-700',
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // move focus into the dialog
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [tabindex]',
    );
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
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
          'max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl dark:bg-neutral-900',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירת החלון"
            className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Spinner / loading ----------
export function Spinner({ label = 'טוען…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-8 text-neutral-500">
      <span className="inline-block size-5 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

// ---------- Empty / error states ----------
export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 py-10 text-center dark:border-neutral-700">
      <p className="font-medium text-neutral-700 dark:text-neutral-300">{title}</p>
      {subtitle && <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>}
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
