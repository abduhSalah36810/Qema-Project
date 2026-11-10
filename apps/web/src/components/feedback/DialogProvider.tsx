import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * حوارات التطبيق الموحدة (بديل alert / confirm / prompt):
 * - confirm: يعرض ملخصاً لما سيحدث قبل العمليات الحساسة ويعيد true/false.
 * - prompt: يطلب نصاً (مثل سبب الرفض) مع إلزام الحقل عند الحاجة، ويعيد النص أو null.
 * - notify: رسالة واضحة بزر «حسناً» (للأخطاء أو التنبيهات التي تستلزم انتباه المستخدم).
 * الحوار عربي RTL، يغلق بزر Esc، ويعيد التركيز للعنصر السابق.
 */
type Tone = 'default' | 'danger' | 'success';

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** نقاط مختصرة تشرح ما سيحدث عند التأكيد */
  summary?: Array<{ label: string; value: ReactNode }>;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
}

interface PromptOptions extends ConfirmOptions {
  label: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  multiline?: boolean;
}

interface NotifyOptions {
  title: string;
  message?: ReactNode;
  tone?: Tone;
  okLabel?: string;
}

interface DialogApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  notify: (options: NotifyOptions) => Promise<void>;
}

type ActiveDialog =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: 'notify'; options: NotifyOptions; resolve: () => void };

// مخزن موحد للحوارات: أي شاشة تطلب حواراً، والمضيف الوحيد (DialogProvider) يعرضه.
let enqueue: ((dialog: ActiveDialog) => void) | null = null;

const dialogApi: DialogApi = {
  confirm: (options) => new Promise<boolean>((resolve) => enqueue?.({ kind: 'confirm', options, resolve })),
  prompt: (options) => new Promise<string | null>((resolve) => enqueue?.({ kind: 'prompt', options, resolve })),
  notify: (options) => new Promise<void>((resolve) => enqueue?.({ kind: 'notify', options, resolve })),
};

/** مضيف الحوارات: يُركّب مرة واحدة في جذر التطبيق. */
export function DialogProvider({ children }: { children?: ReactNode }) {
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  useEffect(() => {
    enqueue = setDialog;
    return () => {
      if (enqueue === setDialog) enqueue = null;
    };
  }, []);
  return (
    <>
      {children}
      {dialog && <AppDialog dialog={dialog} onDone={() => setDialog(null)} />}
    </>
  );
}

export function useDialog(): DialogApi {
  return dialogApi;
}

function AppDialog({ dialog, onDone }: { dialog: ActiveDialog; onDone: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const previousFocus = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tone = dialog.options.tone ?? 'default';

  const cancel = useCallback(() => {
    if (dialog.kind === 'confirm') dialog.resolve(false);
    else if (dialog.kind === 'prompt') dialog.resolve(null);
    else dialog.resolve();
    onDone();
  }, [dialog, onDone]);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    (dialog.kind === 'prompt' ? inputRef.current : primaryRef.current)?.focus();
    const FOCUSABLE =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancel();
        return;
      }
      // حصر التنقل بـ Tab داخل الحوار (Focus trap): لا يخرج التركيز إلى خلفية النافذة
      if (e.key === 'Tab' && containerRef.current) {
        const focusable = Array.from(containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const inside = active !== null && containerRef.current.contains(active);
        if (!e.shiftKey && (active === last || !inside)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (active === first || !inside)) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previousFocus.current?.focus?.();
    };
  }, [dialog, cancel]);

  const accept = () => {
    if (dialog.kind === 'prompt') {
      const value = text.trim();
      const min = dialog.options.minLength ?? (dialog.options.required ? 1 : 0);
      if (value.length < min) {
        setError(min > 1 ? `اكتب ${dialog.options.label} (${min} أحرف على الأقل).` : `${dialog.options.label} مطلوب.`);
        inputRef.current?.focus();
        return;
      }
      dialog.resolve(value);
    } else if (dialog.kind === 'confirm') {
      dialog.resolve(true);
    } else {
      dialog.resolve();
    }
    onDone();
  };

  const { title, message } = dialog.options;
  const summary = dialog.kind !== 'notify' ? dialog.options.summary : undefined;
  const confirmLabel =
    dialog.kind === 'notify' ? dialog.options.okLabel ?? 'حسناً' : dialog.options.confirmLabel ?? 'تأكيد';
  const cancelLabel = dialog.kind !== 'notify' ? dialog.options.cancelLabel ?? 'إلغاء' : null;

  return (
    <div className="app-dialog__backdrop" role="presentation" onClick={cancel}>
      <div
        ref={containerRef}
        className={`app-dialog app-dialog--${tone}`}
        role={dialog.kind === 'notify' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="app-dialog-title" className="app-dialog__title">{title}</h2>
        {message && <div className="app-dialog__message">{message}</div>}
        {summary && summary.length > 0 && (
          <dl className="app-dialog__summary">
            {summary.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {dialog.kind === 'prompt' && (
          <label className="app-dialog__field">
            <span>
              {dialog.options.label}
              {dialog.options.required && <span className="field-required" aria-hidden> *</span>}
            </span>
            {dialog.options.multiline ? (
              <textarea
                ref={inputRef}
                rows={3}
                value={text}
                placeholder={dialog.options.placeholder}
                aria-invalid={Boolean(error)}
                onChange={(e) => { setText(e.target.value); setError(''); }}
              />
            ) : (
              <input
                ref={inputRef}
                value={text}
                placeholder={dialog.options.placeholder}
                aria-invalid={Boolean(error)}
                onChange={(e) => { setText(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') accept(); }}
              />
            )}
            {error && <small className="field-error" role="alert">{error}</small>}
          </label>
        )}
        <div className="app-dialog__actions">
          {cancelLabel && (
            <button type="button" className="btn btn--secondary" onClick={cancel}>{cancelLabel}</button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className={`btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`}
            onClick={accept}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
