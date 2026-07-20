import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Trash2, X } from 'lucide-react';
import Button from '@/components/Button';
import { useToast } from '@/components/Toast';
import { defaultSettings, getSettings, saveSettings } from '@/lib/db';
import type { QualityLevel, Settings } from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * Settings drawer 设置 (lobby.md): right-side drawer, spring slide
 * x 100%→0 (damping 26), 40% dim overlay. Every control debounce-writes to
 * kv.settings via db getSettings/saveSettings.
 *
 * 触屏灵敏度 rides along as an optional extension field on the settings
 * record (the db layer's merge keeps unknown keys); the canonical
 * `sensitivity` field follows design.md §11.6.
 */

type StoredSettings = Settings & { touchSensitivity?: number };

const QUALITY_OPTIONS: { id: QualityLevel; label: string }[] = [
  { id: 'auto', label: '自动' },
  { id: 'high', label: '高' },
  { id: 'medium', label: '中' },
  { id: 'low', label: '低' },
];

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.06 + i * 0.04, duration: 0.25 },
  }),
};

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-bold text-ink">{label}</span>
        <span className="font-mono text-sm text-ink-soft">{display}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer accent-terracotta"
      />
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
  footnote,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  footnote?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-bold text-ink">{label}</div>
        {footnote && <div className="mt-0.5 text-xs text-ink-soft">{footnote}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-7 w-12 shrink-0 rounded-full border-2 border-ink transition-colors duration-200',
          checked ? 'bg-sage' : 'bg-line',
        )}
      >
        <motion.span
          animate={{ x: checked ? 20 : 0 }}
          transition={{ type: 'spring', stiffness: 550, damping: 30 }}
          className="absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-ink bg-snow"
        />
      </button>
    </div>
  );
}

export default function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings>(() => defaultSettings());
  const [touchSensitivity, setTouchSensitivity] = useState(1.0);
  const [loaded, setLoaded] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const timerRef = useRef<number | null>(null);
  const [isCoarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  );

  // load persisted settings the first time the drawer opens
  useEffect(() => {
    if (!open || loaded) return;
    let alive = true;
    void getSettings().then((s) => {
      if (!alive) return;
      const stored = s as StoredSettings;
      setSettings(s);
      setTouchSensitivity(stored.touchSensitivity ?? s.sensitivity);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [open, loaded]);

  const persist = useCallback((next: Settings, touch: number) => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void saveSettings({ ...next, touchSensitivity: touch } as Settings);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const update = useCallback(
    (patch: Partial<Settings>, touch?: number) => {
      const next = { ...settings, ...patch };
      const t = touch ?? touchSensitivity;
      setSettings(next);
      if (touch != null) setTouchSensitivity(touch);
      persist(next, t);
    },
    [persist, settings, touchSensitivity],
  );

  // esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const clearLocalData = useCallback(() => {
    try {
      indexedDB.deleteDatabase('summit-game');
    } catch {
      /* fail-soft: reload clears in-memory state anyway */
    }
    toast('本地数据已清除', 'success');
    window.setTimeout(() => window.location.reload(), 700);
  }, [toast]);

  let row = 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[85] bg-ink"
            onClick={onClose}
          />
          <motion.aside
            key="settings-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            className="fixed inset-y-0 right-0 z-[90] flex w-full flex-col border-l-2 border-ink bg-paper sm:w-[380px]"
            role="dialog"
            aria-label="设置"
          >
            <div className="flex items-center justify-between border-b-2 border-dashed border-line px-6 py-4">
              <h2 className="font-zh text-2xl text-ink">设置</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭设置"
                className="rounded-full p-1.5 text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="flex flex-col gap-6">
                <motion.div variants={rowVariants} custom={row++} initial="hidden" animate="show">
                  <SliderRow
                    label="鼠标灵敏度"
                    value={settings.sensitivity}
                    min={0.3}
                    max={2}
                    step={0.05}
                    display={`×${settings.sensitivity.toFixed(2)}`}
                    onChange={(v) => update({ sensitivity: v })}
                  />
                </motion.div>
                <motion.div variants={rowVariants} custom={row++} initial="hidden" animate="show">
                  <SliderRow
                    label="触屏灵敏度"
                    value={touchSensitivity}
                    min={0.3}
                    max={2}
                    step={0.05}
                    display={`×${touchSensitivity.toFixed(2)}`}
                    onChange={(v) => update({}, v)}
                  />
                </motion.div>
                <motion.div variants={rowVariants} custom={row++} initial="hidden" animate="show">
                  <SwitchRow
                    label="反转 Y 轴"
                    checked={settings.invertY}
                    onChange={(v) => update({ invertY: v })}
                  />
                </motion.div>
                {isCoarse && (
                  <motion.div variants={rowVariants} custom={row++} initial="hidden" animate="show">
                    <SwitchRow
                      label="陀螺仪环视"
                      checked={settings.gyroEnabled}
                      onChange={(v) => update({ gyroEnabled: v })}
                      footnote="游戏内也可随时开关"
                    />
                  </motion.div>
                )}
                <motion.div variants={rowVariants} custom={row++} initial="hidden" animate="show">
                  <div>
                    <div className="mb-1.5 text-sm font-bold text-ink">画质</div>
                    <div className="flex rounded-full border-2 border-ink/10 bg-paper-deep p-1">
                      {QUALITY_OPTIONS.map((q) => {
                        const active = settings.quality === q.id;
                        return (
                          <button
                            key={q.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => update({ quality: q.id })}
                            className={cn(
                              'relative flex-1 rounded-full py-1.5 text-sm font-bold transition-colors',
                              active ? 'text-snow' : 'text-ink-soft hover:text-ink',
                            )}
                          >
                            {active && (
                              <motion.span
                                layoutId="quality-indicator"
                                className="absolute inset-0 rounded-full bg-ink"
                                transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                              />}
                            <span className="relative z-10">{q.label}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-1 text-xs text-ink-soft">影响分辨率与植被密度</div>
                  </div>
                </motion.div>
                <motion.div variants={rowVariants} custom={row++} initial="hidden" animate="show">
                  <SliderRow
                    label="音量"
                    value={settings.volume}
                    min={0}
                    max={1}
                    step={0.05}
                    display={`${Math.round(settings.volume * 100)}%`}
                    onChange={(v) => update({ volume: v })}
                  />
                </motion.div>
                <motion.div variants={rowVariants} custom={row++} initial="hidden" animate="show">
                  <SwitchRow
                    label="减少动态效果"
                    checked={settings.reducedMotion}
                    onChange={(v) => update({ reducedMotion: v })}
                  />
                </motion.div>

                <motion.div
                  variants={rowVariants}
                  custom={row++}
                  initial="hidden"
                  animate="show"
                  className="border-t-2 border-dashed border-line pt-5"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-danger hover:bg-danger/10"
                    onClick={() => setConfirmClear(true)}
                  >
                    <Trash2 size={15} aria-hidden />
                    清除本地数据
                  </Button>
                </motion.div>
              </div>
            </div>

            <div className="border-t-2 border-dashed border-line px-6 py-3 text-center font-mono text-xs text-ink-soft">
              v1.0 · SUMMIT
            </div>

            {/* confirm clear-data modal */}
            <AnimatePresence>
              {confirmClear && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/40 p-6"
                  onClick={() => setConfirmClear(false)}
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.92, y: 16 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 8 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    className="card-warm w-full max-w-xs rounded-3xl p-6 text-center"
                    onClick={(e) => e.stopPropagation()}
                    role="alertdialog"
                    aria-label="确认清除本地数据"
                  >
                    <h3 className="font-zh text-xl text-ink">清除本地数据？</h3>
                    <p className="mt-2 text-sm text-ink-soft">将删除昵称、战绩与设置</p>
                    <div className="mt-5 flex gap-3">
                      <Button variant="secondary" size="sm" className="flex-1" onClick={() => setConfirmClear(false)}>
                        取消
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        className="flex-1"
                        onClick={() => {
                          setConfirmClear(false);
                          clearLocalData();
                        }}
                      >
                        确认清除
                      </Button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
