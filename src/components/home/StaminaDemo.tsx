import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { useToast } from '@/components/Toast';
import { cn } from '@/lib/utils';

/**
 * §5 体力机制 Stamina interactive strip (framer-motion only).
 * Hold 按住抓取 to drain the ring (25%/s), release to regen (25%/s after a
 * 0.6s delay). Under 25% the ring breathes amber→danger; at 0 it flashes,
 * the button shakes and a 力竭 toast fires — mirroring the real game feel.
 */

const R = 72;
const C = 2 * Math.PI * R;

export default function StaminaDemo() {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const inView = useInView(panelRef, { once: true, margin: '-25% 0px' });
  const ringRef = useRef<SVGCircleElement>(null);
  const ringWrapRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);

  const holding = useRef(false);
  const stamina = useRef(100);
  const lastDrain = useRef(0);
  const exhausted = useRef(false);
  const drawT = useRef(0);
  const [exState, setExState] = useState(false);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      if (inView && drawT.current < 1) drawT.current = Math.min(1, drawT.current + dt / 0.8);

      if (holding.current && !exhausted.current) {
        stamina.current = Math.max(0, stamina.current - 25 * dt);
        lastDrain.current = now;
        if (stamina.current <= 0) {
          exhausted.current = true;
          setExState(true);
          toast('力竭！脱手了', 'danger');
        }
      } else if (now - lastDrain.current > 600) {
        stamina.current = Math.min(100, stamina.current + 25 * dt);
      }
      if (!holding.current && exhausted.current) {
        exhausted.current = false;
        setExState(false);
      }

      const shown = stamina.current * drawT.current;
      const low = stamina.current < 25;
      if (ringRef.current) {
        ringRef.current.style.strokeDashoffset = String(C * (1 - shown / 100));
        ringRef.current.style.stroke = low ? '#C84B31' : '#E8A94C';
        ringRef.current.style.filter = low ? 'drop-shadow(0 0 6px rgba(200,75,49,.8))' : 'none';
      }
      if (ringWrapRef.current) {
        // breathing pulse when low
        const s = low ? 1 + 0.06 * Math.sin(now * 0.008) : 1;
        ringWrapRef.current.style.transform = `scale(${s.toFixed(3)})`;
      }
      if (pctRef.current) pctRef.current.textContent = String(Math.round(stamina.current));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [inView, toast]);

  const press = (down: boolean) => (e: React.PointerEvent) => {
    e.preventDefault();
    holding.current = down;
    if (down) {
      lastDrain.current = performance.now();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  return (
    <section className="mx-auto max-w-content px-6 py-20 md:py-28">
      <div className="grid items-center gap-12 md:grid-cols-2">
        {/* interactive demo panel */}
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, x: -40 }}
          animate={inView ? { opacity: 1, x: 0 } : undefined}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-3xl bg-ink p-8 shadow-card md:p-10"
        >
          <div className="hud-glass flex flex-col items-center gap-8 rounded-2xl px-6 py-10">
            <div ref={ringWrapRef} className="relative h-[176px] w-[176px] will-change-transform">
              <svg width="176" height="176" viewBox="0 0 176 176" className="-rotate-90">
                <circle cx="88" cy="88" r={R} stroke="rgba(246,242,233,.15)" strokeWidth="10" fill="none" />
                <circle
                  ref={ringRef}
                  cx="88"
                  cy="88"
                  r={R}
                  stroke="#E8A94C"
                  strokeWidth="10"
                  strokeLinecap="round"
                  fill="none"
                  strokeDasharray={C}
                  strokeDashoffset={C}
                />
              </svg>
              {/* mini crosshair */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-snow">
                <div className="relative flex h-8 w-8 items-center justify-center">
                  <span className="absolute h-4 w-0.5 rounded bg-snow/80" />
                  <span className="absolute h-0.5 w-4 rounded bg-snow/80" />
                </div>
                <span ref={pctRef} className="mt-1 font-mono text-xl font-bold text-amber">
                  100
                </span>
              </div>
            </div>
            <motion.button
              type="button"
              onPointerDown={press(true)}
              onPointerUp={press(false)}
              onPointerCancel={press(false)}
              onContextMenu={(e) => e.preventDefault()}
              animate={exState ? { x: [0, -8, 8, -5, 5, 0] } : { x: 0 }}
              transition={{ duration: 0.4 }}
              className={cn(
                'btn-hard h-16 select-none rounded-full border-2 border-ink px-10 font-btn text-lg font-semibold text-snow',
                exState ? 'bg-danger' : 'bg-terracotta',
              )}
              style={{ touchAction: 'none' }}
            >
              {exState ? '力竭！' : '按住抓取'}
            </motion.button>
            <div className="text-center text-xs text-snow/50">体力归零就会脱手 —— 注意节奏</div>
          </div>
        </motion.div>

        {/* copy */}
        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={inView ? { opacity: 1, x: 0 } : undefined}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="font-latin text-sm font-semibold uppercase tracking-[0.3em] text-terracotta sm:text-base">
            STAMINA
          </div>
          <h2 className="mt-3 font-zh text-display-lg text-ink">抓得住，也要放得下</h2>
          <p className="mt-5 max-w-[480px] leading-[1.7] text-ink-soft">
            按住抓取键就会持续消耗体力，松开站在地面上才能恢复。体力低于 25% 会发出警告 —— 归零，就脱手。
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <span className="rounded-full border-2 border-ink/15 bg-paper-deep px-4 py-1.5 font-mono text-sm font-bold text-ink">
              悬挂 −2.5/s
            </span>
            <span className="rounded-full border-2 border-ink/15 bg-paper-deep px-4 py-1.5 font-mono text-sm font-bold text-ink">
              移动 −6/s
            </span>
            <span className="rounded-full border-2 border-ink/15 bg-paper-deep px-4 py-1.5 font-mono text-sm font-bold text-sage">
              落地 +25/s
            </span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
