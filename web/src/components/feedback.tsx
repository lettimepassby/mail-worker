import { CheckCircle2, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button, Modal, cx } from './ui';

interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
}

interface Feedback {
  toast: (message: string, kind?: Toast['kind']) => void;
  error: (err: unknown) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 5000 : 2500);
  }, []);

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
            ) : (
              <XCircle className="size-4 shrink-0 text-red-400 dark:text-red-600" />
            )}
            {t.message}
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
