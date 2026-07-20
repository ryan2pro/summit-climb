import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/Toast';

/**
 * CodeBox (design.md §8): mono text area + 复制 / 粘贴 buttons with a dashed
 * border — used for WebRTC invite/answer codes.
 *
 * mode='copy'  → read-only display + 复制 button (clipboard API, success
 *                toast + checkmark morph)
 * mode='paste' → editable + 粘贴 button (navigator.clipboard.readText with a
 *                focus-to-paste fallback hint)
 */

export interface CodeBoxProps {
  mode: 'copy' | 'paste';
  value: string;
  onChange?: (value: string) => void;
  label?: string;
  placeholder?: string;
  rows?: number;
  className?: string;
}

export default function CodeBox({
  mode,
  value,
  onChange,
  label,
  placeholder = '粘贴邀请码…',
  rows = 4,
  className,
}: CodeBoxProps) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const doCopy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // fallback: select for manual copy
      areaRef.current?.select();
      document.execCommand?.('copy');
    }
    setCopied(true);
    toast('已复制到剪贴板', 'success');
    setTimeout(() => setCopied(false), 1600);
  }, [value, toast]);

  const doPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onChange?.(text.trim());
        toast('已粘贴', 'success');
        return;
      }
      throw new Error('empty');
    } catch {
      areaRef.current?.focus();
      toast('剪贴板不可用，请手动粘贴（Ctrl/Cmd+V）', 'info');
    }
  }, [onChange, toast]);

  return (
    <div className={cn('w-full', className)}>
      {label && <div className="mb-1.5 text-sm font-bold text-ink-soft">{label}</div>}
      <div className="rounded-2xl border-2 border-dashed border-ink/40 bg-snow/60 p-3">
        <textarea
          ref={areaRef}
          value={value}
          onChange={mode === 'paste' ? (e) => onChange?.(e.target.value) : undefined}
          readOnly={mode === 'copy'}
          placeholder={placeholder}
          rows={rows}
          spellCheck={false}
          className="w-full resize-none break-all rounded-xl bg-transparent font-mono text-[0.9rem] leading-relaxed text-ink placeholder:text-ink-soft/50 focus:outline-none"
        />
        <div className="mt-2 flex justify-end">
          {mode === 'copy' ? (
            <button
              type="button"
              onClick={doCopy}
              disabled={!value}
              className="btn-hard-sm inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-ink bg-terracotta px-4 text-sm font-bold text-snow disabled:opacity-50"
            >
              <motion.span
                key={copied ? 'check' : 'copy'}
                initial={{ scale: 0.4, rotate: -30, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 600, damping: 22 }}
                className="inline-flex"
              >
                {copied ? (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M10.5 5.5v-2A1.6 1.6 0 0 0 8.9 1.9H3.6A1.6 1.6 0 0 0 2 3.5v5.3a1.6 1.6 0 0 0 1.6 1.6h2" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                )}
              </motion.span>
              {copied ? '已复制' : '复制'}
            </button>
          ) : (
            <button
              type="button"
              onClick={doPaste}
              className="btn-hard-sm inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-ink bg-paper-deep px-4 text-sm font-bold text-ink"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M6 2.5h4M5 4H3.6A1.6 1.6 0 0 0 2 5.6v7.2a1.6 1.6 0 0 0 1.6 1.6h8.8a1.6 1.6 0 0 0 1.6-1.6V5.6A1.6 1.6 0 0 0 12.4 4H11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="5" y="1.5" width="6" height="3" rx="1" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              粘贴
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
