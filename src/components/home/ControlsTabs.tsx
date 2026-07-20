import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

/**
 * §6 操作说明 Controls — tabbed split (framer-motion only).
 * Segmented control with a sliding active pill (layoutId, spring); PC panel
 * shows Keycap rows, mobile panel shows a CSS phone mock with joystick /
 * drag-look / grab & jump buttons / gyro toggle.
 */

type TabId = 'pc' | 'mobile';

const TABS: { id: TabId; label: string }[] = [
  { id: 'pc', label: '电脑端' },
  { id: 'mobile', label: '手机端' },
];

function Key({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <span className={cn('keycap', wide && 'px-4 text-sm')}>{children}</span>;
}

const PC_ROWS: { keys: React.ReactNode; action: string }[] = [
  {
    keys: (
      <span className="flex gap-1.5">
        <Key>W</Key>
        <Key>A</Key>
        <Key>S</Key>
        <Key>D</Key>
      </span>
    ),
    action: '移动（跟随视角）',
  },
  {
    keys: (
      <Key wide>
        <span className="flex items-center gap-1.5">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="3" y="1.5" width="10" height="13" rx="5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8 4v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          鼠标
        </span>
      </Key>
    ),
    action: '视角（点击画面锁定指针）',
  },
  { keys: <Key wide>Space</Key>, action: '跳跃 / 悬挂时蹬墙跳' },
  {
    keys: (
      <span className="flex items-center gap-1.5">
        <Key>E</Key>
        <span className="text-ink-soft">/</span>
        <Key wide>左键长按</Key>
      </span>
    ),
    action: '抓取（按住不放，松开脱手）',
  },
  { keys: <Key>R</Key>, action: '回到营地（重生点）' },
  { keys: <Key wide>Esc</Key>, action: '暂停菜单' },
];

const MOBILE_BULLETS = ['左半屏 虚拟摇杆移动', '右半屏 拖动视角', '陀螺仪 一键环视（可开关）', '抓取 按住不放 · 跳 点按'];

function PhoneMock() {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    el.style.transform = `perspective(900px) rotateY(${(nx * 2).toFixed(2)}deg) rotateX(${(-ny * 2).toFixed(2)}deg)`;
  };
  const onLeave = () => {
    if (ref.current) ref.current.style.transform = 'perspective(900px) rotateY(0deg) rotateX(0deg)';
  };
  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      className="mx-auto w-full max-w-[560px] rounded-[2rem] border-[3px] border-ink bg-ink p-2.5 shadow-card transition-transform duration-200 ease-out"
    >
      <div className="relative h-[300px] overflow-hidden rounded-3xl bg-gradient-to-b from-sky/60 to-paper-deep sm:h-[320px]">
        {/* mini mountain silhouette */}
        <svg viewBox="0 0 560 320" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMax slice" aria-hidden>
          <path d="M0 320 180 110l60 52 90-84 230 242Z" fill="#9B8571" opacity="0.8" />
          <path d="M262 96l68-62 38 44-30 20-22-14-18 24Z" fill="#F2EFE7" />
          <rect x="326" y="14" width="3" height="26" fill="#2E2418" />
          <path d="M329 16l26 7-26 9Z" fill="#D0713F" />
        </svg>
        {/* joystick ghost (left half) */}
        <div className="absolute bottom-8 left-8 flex h-[110px] w-[110px] items-center justify-center rounded-full border-2 border-dashed border-snow/50 bg-snow/15">
          <div className="h-[48px] w-[48px] rounded-full bg-snow/60 shadow" />
        </div>
        <span className="absolute bottom-2 left-10 text-[10px] font-bold text-ink/60">移动</span>
        {/* drag-look indicator (right half) */}
        <div className="absolute right-10 top-10 flex h-16 w-24 items-center justify-center rounded-xl border-2 border-dashed border-ink/30 text-ink/50">
          <svg width="34" height="18" viewBox="0 0 34 18" fill="none" aria-hidden>
            <path d="M2 9h30M6 4 2 9l4 5M28 4l4 5-4 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="absolute right-14 top-[104px] text-[10px] font-bold text-ink/60">视角</span>
        {/* gyro toggle */}
        <div className="absolute left-3 top-3 flex h-10 w-10 items-center justify-center rounded-full border-2 border-ink/40 bg-snow/70 text-ink">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
            <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.6" />
            <path d="M9 4.5 11 9l-2 4.5L7 9Z" fill="currentColor" />
          </svg>
        </div>
        {/* pause */}
        <div className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full border-2 border-ink/40 bg-snow/70 text-ink">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M4 2.5v9M10 2.5v9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </div>
        {/* grab + jump buttons */}
        <div className="absolute bottom-8 right-6 flex items-end gap-3">
          <div className="flex h-[64px] w-[64px] items-center justify-center rounded-full border-2 border-ink/50 bg-amber/90 text-sm font-bold text-ink shadow-hard-sm">
            跳
          </div>
          <div className="flex h-[78px] w-[78px] items-center justify-center rounded-full border-2 border-ink/60 bg-terracotta/90 text-sm font-bold text-snow shadow-hard">
            抓取
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ControlsTabs() {
  const [tab, setTab] = useState<TabId>('pc');
  const rootRef = useRef<HTMLElement>(null);

  return (
    <section ref={rootRef} id="controls" className="mx-auto max-w-content scroll-mt-20 px-6 py-24 md:py-32">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-30% 0px' }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="text-center">
          <div className="font-latin text-sm font-semibold uppercase tracking-[0.3em] text-terracotta sm:text-base">
            CONTROLS
          </div>
          <h2 className="mt-3 font-zh text-display-lg text-ink">简单到只用四个键</h2>
          <div className="mx-auto mt-5 w-24 border-t-2 border-dashed border-line" aria-hidden />
        </div>

        {/* segmented control */}
        <div className="mt-10 flex justify-center">
          <div className="inline-flex rounded-full border-2 border-ink bg-paper-deep p-1.5 shadow-hard-sm">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'relative rounded-full px-7 py-2.5 text-base font-bold transition-colors',
                  tab === t.id ? 'text-snow' : 'text-ink hover:text-terracotta',
                )}
              >
                {tab === t.id && (
                  <motion.span
                    layoutId="controls-tab-pill"
                    className="absolute inset-0 rounded-full bg-ink"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative z-10">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* panels */}
        <div className="mt-12">
          <AnimatePresence mode="wait">
            {tab === 'pc' ? (
              <motion.div
                key="pc"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.15 }}
                className="mx-auto max-w-2xl"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {PC_ROWS.map((row, i) => (
                    <motion.div
                      key={row.action}
                      initial={{ opacity: 0, x: -24 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.05 + i * 0.06, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                      className="flex items-center gap-4 rounded-2xl border-2 border-ink/10 bg-paper-deep px-5 py-4"
                    >
                      <div className="flex min-w-[120px] items-center">{row.keys}</div>
                      <div className="text-sm font-medium text-ink">{row.action}</div>
                    </motion.div>
                  ))}
                </div>
                <p className="mt-6 text-center text-sm text-ink-soft">点击游戏画面锁定鼠标指针</p>
              </motion.div>
            ) : (
              <motion.div
                key="mobile"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.15 }}
              >
                <motion.div
                  initial={{ opacity: 0, x: -24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <PhoneMock />
                </motion.div>
                <div className="mx-auto mt-8 grid max-w-2xl gap-3 sm:grid-cols-2">
                  {MOBILE_BULLETS.map((b, i) => (
                    <motion.div
                      key={b}
                      initial={{ opacity: 0, x: -24 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.05 + i * 0.06, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                      className="flex items-center gap-3 rounded-2xl border-2 border-ink/10 bg-paper-deep px-5 py-3.5 text-sm font-medium text-ink"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-terracotta" />
                      {b}
                    </motion.div>
                  ))}
                </div>
                <p className="mt-6 text-center text-sm text-ink-soft">建议横屏游玩</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </section>
  );
}
