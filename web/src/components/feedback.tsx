import { CheckCircle2, Mail, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button, Modal, cx } from './ui';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
  action?: ToastAction;
}

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
}

interface Feedback {
  toast: (message: string, kind?: Toast['kind'], action?: ToastAction) => void;
  error: (err: unknown) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback(
    (message: string, kind: Toast['kind'] = 'success', action?: ToastAction) => {
      const id = nextId.current++;
      // Keep at most three on screen (a burst of new mail shouldn't bury the page).
      setToasts((t) => [...t.slice(-2), { id, kind, message, action }]);
      setTimeout(() => dismiss(id), action ? 8000 : kind === 'error' ? 5000 : 2500);
    },
    [dismiss],
  );

  const error = useCallback((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'), [toast]);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setPending(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPending(null);
  };

  return (
    <Ctx.Provider value={{ toast, error, confirm }}>
      {children}
      <Modal
        open={!!pending}
        title={pending?.title ?? ''}
        onClose={() => settle(false)}
        footer={
          <>
            <Button onClick={() => settle(false)}>取消</Button>
            <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus>
              {pending?.confirmText ?? '确定'}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{pending?.message}</div>
      </Modal>
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex max-w-md items-center gap-2 rounded-xl px-4 py-2.5 text-sm shadow-lg ring-1',
              'bg-zinc-900 text-white ring-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-200',
            )}
          >
            {t.kind === 'success' ? (
              <CheckCircle2 className="size-4 shrink-0 text-emerald-400 dark:text-emerald-600" />
            ) : t.kind === 'info' ? (
              <Mail className="size-4 shrink-0 text-blue-300 dark:text-blue-600" />
            ) : (
              <XCircle className="size-4 shrink-0 text-red-400 dark:text-red-600" />
            )}
            <span className="min-w-0 truncate">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="ml-1 shrink-0 rounded-md bg-white/15 px-2 py-0.5 text-[13px] font-medium hover:bg-white/25 dark:bg-zinc-900/10 dark:hover:bg-zinc-900/20"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useFeedback(): Feedback {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('FeedbackProvider missing');
  return ctx;
}
