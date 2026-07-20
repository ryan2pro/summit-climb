import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

/**
 * Toast system (design.md §8 `Toast`): top-center stack, paper card on
 * landing/lobby, glass-dark on game pages. Slide-down spring entrance,
 * auto-dismiss after 3s.
 *
 * Usage:
 *   <ToastProvider>…</ToastProvider>
 *   const toast = useToast();
 *   toast('已连接'); toast('力竭！脱手了', 'danger');
 */

export type ToastVariant = 'default' | 'success' | 'danger' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  dark: boolean;
}

interface ToastApi {
  (message: string, variant?: ToastVariant): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const iconByVariant: Record<ToastVariant, ReactNode> = {
  default: null,
  success: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  danger: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2v7M8 12.6v.4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  ),
  info: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 7.2v3.4M8 4.6v.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
};

const accentByVariant: Record<ToastVariant, string> = {
  default: 'text-ink',
  success: 'text-sage',
  danger: 'text-danger',
  info: 'text-sky',
};

export function ToastProvider({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback(
    (message: string, variant: ToastVariant = 'default') => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, message, variant, dark }]);
      setTimeout(() => {
        setToasts((list) => list.filter((t) => t.id !== id));
      }, 3000);
    },
    [dark],
  );

  const api = useMemo<ToastApi>(() => push, [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed left-1/2 top-4 z-[100] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout="position"
              initial={{ opacity: 0, y: -32, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 500, damping: 32 }}
              className={cn(
                'pointer-events-auto flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold shadow-card',
                t.dark ? 'hud-glass text-snow' : 'border-2 border-ink bg-paper text-ink',
              )}
              role="status"
            >
              <span className={cn('shrink-0', t.dark ? 'text-amber' : accentByVariant[t.variant])}>
                {iconByVariant[t.variant]}
              </span>
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook co-located with its provider
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // usable outside provider as a no-op console fallback (defensive)
    return (msg: string) => console.warn('[toast:unmounted]', msg);
  }
  return ctx;
}
