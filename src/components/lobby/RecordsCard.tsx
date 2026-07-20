import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Flag, Mountain, X } from 'lucide-react';
import Card from '@/components/Card';
import { useSession } from '@/lib/session';
import { formatSeed } from '@/lib/prng';
import type { RunRecord } from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * Records card 最近战绩 (lobby.md): latest 8 runs from the IndexedDB records
 * store, stats footer from profile.stats, and a 全部 modal with the last 50.
 */

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function relDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const dt = new Date(t);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}

/** Count-up animation for stat numbers (800ms, disabled for reduced motion). */
function useCountUp(target: number, duration = 800): number {
  const reduced = useReducedMotion();
  const [v, setV] = useState(0);
  // reduced motion: jump straight to the target (adjust-during-render)
  if (reduced && v !== target) setV(target);
  useEffect(() => {
    if (reduced || target === 0) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);
  return v;
}

function RecordRow({ rec, index }: { rec: RunRecord; index: number }) {
  return (
    <motion.li
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05, duration: 0.25 }}
      className="flex h-11 items-center gap-2.5 border-b border-dashed border-line/70 text-sm last:border-b-0"
    >
      <Flag
        size={15}
        aria-label={rec.summited ? '登顶' : '未登顶'}
        className={cn('shrink-0', rec.summited ? 'fill-terracotta text-terracotta' : 'text-line')}
      />
      <span className="font-mono text-[0.85rem] font-bold text-ink">#{formatSeed(rec.seed)}</span>
      <span className="font-mono text-[0.85rem] text-ink-soft">
        {rec.summited && rec.timeMs != null ? fmtTime(rec.timeMs) : `${Math.round(rec.peakAltitude)}m`}
      </span>
      <span className="ml-auto shrink-0 text-xs text-ink-soft/80">{relDate(rec.date)}</span>
      <span className="shrink-0 text-xs text-ink-soft/80">{rec.players}人</span>
    </motion.li>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line px-4 py-8 text-center">
      <Mountain size={28} className="text-line" aria-hidden />
      <p className="text-sm font-bold text-ink-soft">还没有战绩，去爬第一座山吧！</p>
    </div>
  );
}

export default function RecordsCard() {
  const { recentRecords, profile } = useSession();
  const [records, setRecords] = useState<RunRecord[] | null>(null);
  const [allRecords, setAllRecords] = useState<RunRecord[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    void recentRecords(8).then((rs) => {
      if (alive) setRecords(rs);
    });
    return () => {
      alive = false;
    };
  }, [recentRecords]);

  useEffect(() => {
    if (!showAll) return;
    let alive = true;
    void recentRecords(50).then((rs) => {
      if (alive) setAllRecords(rs);
    });
    return () => {
      alive = false;
    };
  }, [showAll, recentRecords]);

  const summits = useCountUp(profile.stats.summits);
  const maxAlt = useCountUp(Math.round(profile.stats.maxAltitudeM));

  return (
    <Card radius="lg" className="p-6">
      <div className="flex items-center justify-between">
        <h3 className="font-zh text-2xl text-ink">最近战绩</h3>
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-sm font-bold text-terracotta underline-offset-4 hover:underline"
        >
          全部
        </button>
      </div>

      <div className="mt-3">
        {records == null ? (
          <div className="py-6 text-center text-sm text-ink-soft">读取中…</div>
        ) : records.length === 0 ? (
          <EmptyState />
        ) : (
          <ul>
            {records.map((r, i) => (
              <RecordRow key={r.id ?? `${r.seed}-${r.date}`} rec={r} index={i} />
            ))}
          </ul>
        )}
      </div>

      {/* stats footer: 登顶 4 次 · 最佳 08:12 · 最高 141m */}
      <div className="mt-4 flex items-center justify-between gap-2 border-t-2 border-dashed border-line pt-4 text-sm text-ink-soft">
        <span>
          登顶 <b className="font-mono text-base font-bold text-ink">{summits}</b> 次
        </span>
        <span>
          最佳{' '}
          <b className="font-mono text-base font-bold text-amber">
            {profile.stats.bestTimeMs != null ? fmtTime(profile.stats.bestTimeMs) : '--:--'}
          </b>
        </span>
        <span>
          最高 <b className="font-mono text-base font-bold text-ink">{maxAlt}m</b>
        </span>
      </div>

      {/* 全部 modal (last 50) */}
      <AnimatePresence>
        {showAll && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/40 p-4"
            onClick={() => setShowAll(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className="card-warm w-full max-w-md rounded-3xl p-6"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="全部战绩"
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-zh text-2xl text-ink">全部战绩</h3>
                <button
                  type="button"
                  onClick={() => setShowAll(false)}
                  aria-label="关闭"
                  className="rounded-full p-1.5 text-ink-soft hover:bg-ink/5 hover:text-ink"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="max-h-[50dvh] overflow-y-auto pr-1">
                {allRecords == null ? (
                  <div className="py-6 text-center text-sm text-ink-soft">读取中…</div>
                ) : allRecords.length === 0 ? (
                  <EmptyState />
                ) : (
                  <ul>
                    {allRecords.map((r, i) => (
                      <RecordRow key={r.id ?? `${r.seed}-${r.date}`} rec={r} index={i} />
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
