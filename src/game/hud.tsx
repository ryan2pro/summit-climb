/**
 * HUD — DOM overlay for the game page (game.md §1–§9).
 *
 * Dark glass system (hud-glass, snow text, amber accents), pointer-events:
 * none except interactive controls. High-frequency widgets (stamina ring,
 * timer, altitude markers, joystick) read a mutable HudData ref inside
 * requestAnimationFrame and write straight to the DOM — zero React
 * re-renders per frame (game.md §10 perf contract).
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { formatSeed } from '@/lib/prng';
import type { Settings } from '@/lib/db';
import type { EmoteKind } from '@/lib/net';
import type { InputManager } from './input';
import CodeBox from '@/components/CodeBox';
import { COSMETIC_ZH, formatTime, formatTimeCs } from './hud-utils';

/* --------------------------------- types --------------------------------- */

export type GamePhase = 'boot' | 'ready' | 'playing' | 'summit';

/** mutable per-frame data written by the game loop, read by HUD widgets */
export interface HudData {
  stamina: number;
  hanging: boolean;
  /** exhaustion slide in progress (scraping down the wall) */
  sliding: boolean;
  /** a hanging teammate below is in helping-hand range */
  helpAvailable: boolean;
  exhausted: boolean;
  canGrab: boolean;
  altitude: number;
  timeMs: number;
  falls: number;
  grabbed: boolean; // set once on first grab (key hints fade)
}

export interface LoadingInfo {
  label: string;
  frac: number;
}

export interface TeamEntry {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  isSelf: boolean;
  altitude: number;
  checkpoint: number;
  summited: boolean;
  ping?: number;
  /** ICE silent > 5s → reconnecting indicator */
  lost?: boolean;
}

export interface CheckpointTick {
  index: number;
  frac: number; // 0..1 of mountain height
  name: string;
}

export interface VictoryData {
  timeMs: number;
  isRecord: boolean;
  bestMs: number | null;
  altitude: number;
  checkpoints: number;
  falls: number;
  players: number;
  unlocks: string[];
  teammates: TeamEntry[];
  canRestart: boolean;
}

export interface InviteState {
  offer: string;
  busy: boolean;
  error: string | null;
}

export interface HudActions {
  start: () => void;
  resume: () => void;
  pause: () => void;
  respawn: () => void;
  leave: () => void;
  again: () => void;
  backToLobby: () => void;
  emote: (e: EmoteKind) => void;
  gyroToggle: () => void;
  settingsChange: (patch: Partial<Settings>) => void;
  makeInvite: () => void;
  acceptAnswer: (code: string) => void;
  loadingDone: () => void;
}

/** rAF loop hook for per-frame HUD widgets */
function useHudFrame(cb: () => void): void {
  const ref = useRef(cb);
  // keep the latest callback in the ref from inside an effect — writing a
  // ref during render is illegal (React Compiler / concurrent rendering)
  useEffect(() => {
    ref.current = cb;
  });
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      ref.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/* --------------------------------- icons --------------------------------- */

const stroke = { stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, fill: 'none' };

export function IconPause({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <path d="M7 4.5v11M13 4.5v11" {...stroke} strokeWidth={3} />
    </svg>
  );
}

function IconCompass({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" {...stroke} />
      <path d="M15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5Z" {...stroke} strokeLinejoin="round" />
    </svg>
  );
}

function IconWave() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="14" r="2" fill="currentColor" />
      <path d="M13 12a5 5 0 0 1 4-4M13 7a9 9 0 0 1 8-2" {...stroke} />
    </svg>
  );
}

function IconCheer() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1" {...stroke} />
    </svg>
  );
}

function IconPoint() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 12h10" {...stroke} />
      <path d="M14 6.5 20 12l-6 5.5z" fill="currentColor" />
    </svg>
  );
}

function IconSos() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <text x="12" y="15.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor" fontFamily="Fredoka, sans-serif">
        SOS
      </text>
      <circle cx="12" cy="12" r="9" {...stroke} strokeWidth={1.8} />
    </svg>
  );
}

const EMOTES: { kind: EmoteKind; label: string; icon: () => ReactElement }[] = [
  { kind: 'wave', label: '挥手', icon: IconWave },
  { kind: 'cheer', label: '欢呼', icon: IconCheer },
  { kind: 'point', label: '指路', icon: IconPoint },
  { kind: 'sos', label: '求救', icon: IconSos },
];

/* ------------------------------ loading screen ------------------------------ */

function LoadingScreen({
  loading,
  seed,
  bestMs,
  wiping,
  onDone,
}: {
  loading: LoadingInfo;
  seed: number;
  bestMs: number | null;
  wiping: boolean;
  onDone: () => void;
}) {
  return (
    <div
      className="pointer-events-auto absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-ink"
      style={{
        // iris-wipe reveal: full ink cover shrinks to a point on completion
        clipPath: wiping ? 'circle(0% at 50% 50%)' : 'circle(141% at 50% 50%)',
        transition: wiping ? 'clip-path 600ms cubic-bezier(.22,1,.36,1)' : undefined,
      }}
      onTransitionEnd={(e) => {
        if (wiping && e.propertyName === 'clip-path') onDone();
      }}
    >
      <img
        src="/logo.svg"
        alt=""
        className="h-12 w-12 animate-spin"
        style={{ animationDuration: '1.4s', animationTimingFunction: 'linear' }}
      />
      <div className="w-[280px]">
        <div className="h-2 w-full overflow-hidden rounded-full bg-paper-deep/25">
          <div
            className="h-full rounded-full bg-terracotta transition-all duration-300 ease-out"
            style={{ width: `${Math.round(loading.frac * 100)}%` }}
          />
        </div>
      </div>
      <div key={loading.label} className="animate-fade-in text-lg font-bold text-snow">
        {loading.label}
      </div>
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-snow/10 px-3 py-1 font-mono text-xs text-snow/80">
          种子 #{formatSeed(seed)}
        </span>
        {bestMs != null && (
          <span className="rounded-full bg-amber/20 px-3 py-1 font-mono text-xs font-bold text-amber">
            历史最佳 {formatTime(bestMs)}
          </span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- ready gate -------------------------------- */

function Keycap({ children }: { children: string }) {
  return (
    <span className="inline-flex h-9 min-w-9 items-center justify-center rounded-[10px] border border-snow/30 bg-snow/10 px-2 font-mono text-sm font-bold text-snow">
      {children}
    </span>
  );
}

function ReadyGate({ isMobile, onStart }: { isMobile: boolean; onStart: () => void }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.2 } }}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
        className="hud-glass pointer-events-auto flex w-full max-w-[400px] flex-col items-center gap-5 rounded-3xl px-8 py-8 text-center"
      >
        <div>
          <div className="font-latin text-xs font-semibold tracking-[0.3em] text-amber">SUMMIT</div>
          <h2 className="mt-1 font-zh text-3xl text-snow">准备攀登</h2>
        </div>
        {isMobile ? (
          <p className="text-sm leading-relaxed text-snow/80">左摇杆移动 · 右侧拖动视角 · 按住抓取攀爬陡壁 · 悬挂时点「跳」上跃 · 队友在下方时长按「拉手」</p>
        ) : (
          <>
            <p className="text-sm text-snow/80">点击画面锁定鼠标</p>
            <div className="flex items-center justify-center gap-2">
              {['W', 'A', 'S', 'D'].map((k, i) => (
                <motion.span
                  key={k}
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.15 + i * 0.05, type: 'spring', stiffness: 500, damping: 22 }}
                >
                  <Keycap>{k}</Keycap>
                </motion.span>
              ))}
              <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.35, type: 'spring', stiffness: 500, damping: 22 }}>
                <Keycap>Space</Keycap>
              </motion.span>
              <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.4, type: 'spring', stiffness: 500, damping: 22 }}>
                <Keycap>E</Keycap>
              </motion.span>
              <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.45, type: 'spring', stiffness: 500, damping: 22 }}>
                <Keycap>Shift</Keycap>
              </motion.span>
              <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.5, type: 'spring', stiffness: 500, damping: 22 }}>
                <Keycap>RMB</Keycap>
              </motion.span>
            </div>
            <p className="text-xs leading-relaxed text-snow/60">按住 E 攀爬任意陡壁 · Shift 地面冲刺/悬挂上跃 · RMB 拉队友一把</p>
          </>
        )}
        <button
          type="button"
          onClick={onStart}
          className="h-14 w-full rounded-full border-2 border-ink bg-terracotta font-btn text-lg font-semibold text-snow shadow-hard transition-transform hover:bg-terracotta-deep active:translate-y-1 active:scale-[0.97] active:shadow-hard-pressed"
        >
          开始
        </button>
      </motion.div>
    </div>
  );
}

/* ------------------------- crosshair + stamina ring ------------------------- */

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

function Crosshair({ hud }: { hud: RefObject<HudData> }) {
  const arcRef = useRef<SVGCircleElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  useHudFrame(() => {
    const d = hud.current;
    const arc = arcRef.current;
    const wrap = wrapRef.current;
    if (!arc || !wrap) return;
    const frac = Math.max(0, Math.min(1, d.stamina / 100));
    arc.style.strokeDashoffset = String(RING_C * (1 - frac));
    const low = d.stamina < 25;
    arc.style.stroke = d.sliding || d.exhausted || low ? '#C84B31' : '#E8A94C';
    wrap.style.transform = `translate(-50%,-50%) scale(${d.canGrab ? 1.23 : d.sliding ? 1.18 : 1})`;
    wrap.style.opacity = d.exhausted || d.sliding ? (Math.floor(performance.now() / 120) % 2 === 0 ? '0.45' : '1') : '1';
    wrap.style.animation = low && !d.exhausted && !d.sliding ? 'hud-breathe 1s ease-in-out infinite' : 'none';
    if (labelRef.current) {
      const label = labelRef.current;
      const show = d.canGrab || d.sliding;
      label.style.opacity = show ? '1' : '0';
      const text = d.sliding ? '打滑！' : '可抓取';
      if (label.textContent !== text) label.textContent = text;
      label.style.background = d.sliding ? 'rgba(200,75,49,0.9)' : '';
    }
  });
  return (
    <>
      <style>{`@keyframes hud-breathe { 0%,100% { filter: none } 50% { filter: drop-shadow(0 0 6px rgba(200,75,49,.9)) } }`}</style>
      <div ref={wrapRef} className="pointer-events-none absolute left-1/2 top-1/2 z-10 transition-transform duration-150" style={{ transform: 'translate(-50%,-50%)' }}>
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={RING_R} fill="none" stroke="rgba(246,242,233,0.18)" strokeWidth="5" />
          <circle
            ref={arcRef}
            cx="32"
            cy="32"
            r={RING_R}
            fill="none"
            stroke="#E8A94C"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset="0"
            transform="rotate(-90 32 32)"
          />
          <circle cx="32" cy="32" r="2.2" fill="#F6F2E9" />
        </svg>
      </div>
      <div
        ref={labelRef}
        className="pointer-events-none absolute left-1/2 top-1/2 z-10 mt-11 -translate-x-1/2 rounded-full bg-amber/90 px-2.5 py-0.5 text-xs font-bold text-ink transition-opacity duration-150"
        style={{ opacity: 0 }}
      >
        可抓取
      </div>
    </>
  );
}

/* ------------------------------- top center ------------------------------- */

function TopCenter({ hud, compact }: { hud: RefObject<HudData>; compact: boolean }) {
  const timeRef = useRef<HTMLDivElement>(null);
  const altRef = useRef<HTMLDivElement>(null);
  const acc = useRef(0);
  useHudFrame(() => {
    const now = performance.now();
    if (now - acc.current < 250) return;
    acc.current = now;
    const d = hud.current;
    if (timeRef.current) timeRef.current.textContent = formatTime(d.timeMs);
    if (altRef.current) altRef.current.textContent = `⛰ ${Math.max(0, Math.round(d.altitude))}m`;
  });
  return (
    <div
      className={cn('pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2 text-center', compact && 'top-2')}
      style={compact ? { marginTop: 'env(safe-area-inset-top)' } : undefined}
    >
      <div ref={timeRef} className={cn('hud-glass inline-block rounded-2xl px-4 font-mono font-bold text-snow', compact ? 'py-1 text-base' : 'py-1.5 text-xl')}>
        00:00
      </div>
      <div ref={altRef} className={cn('mt-1 font-mono text-amber', compact ? 'text-xs' : 'text-sm')} style={{ textShadow: '0 1px 4px rgba(24,17,10,.7)' }}>
        ⛰ 0m
      </div>
    </div>
  );
}

/* ------------------------------- team chips ------------------------------- */

function TeamChips({ team, compact }: { team: TeamEntry[]; compact: boolean }) {
  return (
    <div className={cn('pointer-events-none absolute left-4 z-20 flex flex-col items-start gap-1.5', compact ? 'left-2 top-2' : 'top-4')}>
      {team.map((p) => (
        <div
          key={p.id}
          className={cn(
            'hud-glass inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-snow',
            compact ? 'text-[0.7rem]' : 'text-xs',
            p.summited && 'ring-1 ring-amber',
          )}
        >
          <span className={cn('shrink-0 rounded-full', compact ? 'h-2.5 w-2.5' : 'h-3 w-3')} style={{ backgroundColor: p.color }} />
          {!compact && (
            <span className="max-w-[7rem] truncate font-bold">
              {p.name}
              {p.isSelf && <span className="ml-0.5 font-normal text-snow/60">（我）</span>}
            </span>
          )}
          {p.isHost && !compact && <span className="rounded-full bg-amber px-1.5 text-[0.6rem] font-bold leading-4 text-ink">房主</span>}
          <span className="font-mono text-amber">{Math.round(p.altitude)}m</span>
          {p.summited && <span className="text-amber">⚑</span>}
          {p.lost && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky" title="正在重连" />}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------- ping badge -------------------------------- */

function PingBadge({ solo, ping }: { solo: boolean; ping: number | null }) {
  const cls = solo || ping == null ? 'text-snow/70' : ping < 80 ? 'text-sage' : ping < 160 ? 'text-amber' : 'text-danger';
  return (
    <span className={cn('hud-glass inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-xs', cls)}>
      <span className={cn('h-1.5 w-1.5 rounded-full bg-current', !solo && ping != null && ping >= 160 && 'animate-pulse')} />
      {solo ? '单人' : `${Math.round(ping ?? 0)}ms`}
    </span>
  );
}

/* ------------------------------ altitude meter ------------------------------ */

function AltitudeMeter({
  hud,
  team,
  checkpoints,
  heightM,
  slim,
}: {
  hud: RefObject<HudData>;
  team: TeamEntry[];
  checkpoints: CheckpointTick[];
  heightM: number;
  slim: boolean;
}) {
  const railH = slim ? 160 : 220;
  const selfRef = useRef<HTMLDivElement>(null);
  const mateRefs = useRef(new Map<string, HTMLDivElement>());
  const tickRefs = useRef(new Map<number, HTMLSpanElement>());
  const teamRef = useRef(team);
  const checkpointsRef = useRef(checkpoints);
  // mirror latest props into refs from an effect (ref writes during render
  // are illegal); the rAF loop below reads them, not the closures
  useEffect(() => {
    teamRef.current = team;
    checkpointsRef.current = checkpoints;
  });
  const shown = useRef(new Map<string, number>());
  useHudFrame(() => {
    const d = hud.current;
    const fracSelf = Math.max(0, Math.min(1, d.altitude / heightM));
    const prevSelf = shown.current.get('__self') ?? fracSelf;
    const nextSelf = prevSelf + (fracSelf - prevSelf) * 0.12;
    shown.current.set('__self', nextSelf);
    if (selfRef.current) {
      selfRef.current.style.transform = `translateY(${(1 - nextSelf) * (railH - 14)}px)`;
    }
    // checkpoint ticks light up once the smoothed self-altitude passes them;
    // driven per-frame via DOM writes (terracotta #D0713F / snow 30%)
    for (const c of checkpointsRef.current) {
      const el = tickRefs.current.get(c.index);
      if (el) el.style.backgroundColor = c.frac <= nextSelf ? '#D0713F' : 'rgba(246,242,233,0.3)';
    }
    for (const p of teamRef.current) {
      if (p.isSelf) continue;
      const el = mateRefs.current.get(p.id);
      if (!el) continue;
      const frac = Math.max(0, Math.min(1, p.altitude / heightM));
      const prev = shown.current.get(p.id) ?? frac;
      const next = prev + (frac - prev) * 0.12;
      shown.current.set(p.id, next);
      el.style.transform = `translateY(${(1 - next) * (railH - 10)}px)`;
    }
  });
  return (
    <div
      className={cn('pointer-events-none absolute z-20', slim ? 'right-2 bottom-36' : 'right-5 top-1/2 -translate-y-1/2')}
      style={{ height: railH + 28 }}
    >
      <div className="hud-glass relative h-full w-11 rounded-2xl">
        {/* mountain silhouette */}
        <svg className="absolute inset-x-0 top-2 mx-auto" width="20" height={railH} viewBox={`0 0 20 ${railH}`} aria-hidden>
          <path
            d={`M10 4 L17 ${railH * 0.45} L14 ${railH * 0.5} L19 ${railH - 4} L1 ${railH - 4} L6 ${railH * 0.55} L4 ${railH * 0.5} Z`}
            fill="none"
            stroke="rgba(246,242,233,0.35)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M10 4 L13 10 L7 10 Z" fill="rgba(246,242,233,0.5)" />
        </svg>
        {/* summit flag */}
        <span className="absolute left-1/2 top-0.5 -translate-x-1/2 text-[0.65rem] text-terracotta">⚑</span>
        {/* checkpoint ticks */}
        {checkpoints.map((c) => (
          <span
            key={c.index}
            ref={(el) => {
              if (el) tickRefs.current.set(c.index, el);
              else tickRefs.current.delete(c.index);
            }}
            title={c.name}
            className="absolute left-1.5 h-[3px] w-3 rounded-full bg-snow/30"
            style={{ top: 8 + (1 - c.frac) * (railH - 14) }}
          />
        ))}
        {/* teammates */}
        {team
          .filter((p) => !p.isSelf)
          .map((p) => (
            <div
              key={p.id}
              ref={(el) => {
                if (el) mateRefs.current.set(p.id, el);
                else mateRefs.current.delete(p.id);
              }}
              className="absolute left-[7px] top-2 h-2.5 w-2.5 rounded-full border border-ink/60"
              style={{ backgroundColor: p.color }}
            />
          ))}
        {/* self marker */}
        <div ref={selfRef} className="absolute right-[7px] top-2">
          <div className="h-0 w-0 border-y-[5px] border-l-[8px] border-y-transparent border-l-amber" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- key hints ------------------------------- */

function KeyHints({ hud }: { hud: RefObject<HudData> }) {
  const ref = useRef<HTMLDivElement>(null);
  // stamp the mount time in an effect — calling performance.now() during
  // render is impure (React Compiler rule)
  const start = useRef(0);
  useEffect(() => {
    start.current = performance.now();
  }, []);
  useHudFrame(() => {
    const el = ref.current;
    if (!el) return;
    const age = performance.now() - start.current;
    const hide = hud.current.grabbed || age > 60000;
    el.style.opacity = hide ? '0' : '1';
  });
  return (
    <div ref={ref} className="pointer-events-none absolute bottom-5 left-5 z-20 flex gap-2 transition-opacity duration-700">
      {['WASD 移动', 'Space 跳', '按住 E 攀爬陡壁', 'Shift 冲刺·上跃', 'RMB 援手'].map((t) => (
        <span key={t} className="hud-glass rounded-full px-3 py-1.5 font-mono text-xs text-snow/85">
          {t}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------- emote bar ------------------------------- */

function EmoteBar({ onEmote, compact }: { onEmote: (e: EmoteKind) => void; compact: boolean }) {
  return (
    <div className={cn('pointer-events-auto absolute z-20 flex gap-2', compact ? 'bottom-24 left-3' : 'bottom-5 right-5')}>
      {EMOTES.map((e) => (
        <button
          key={e.kind}
          type="button"
          title={e.label}
          onClick={() => onEmote(e.kind)}
          className={cn(
            'hud-glass flex items-center justify-center rounded-full text-snow transition hover:bg-snow/25 active:scale-90',
            compact ? 'h-10 w-10' : 'h-11 w-11',
          )}
        >
          <e.icon />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ context prompts ------------------------------ */

export interface Prompt {
  id: number;
  text: string;
}

function Prompts({ prompts }: { prompts: Prompt[] }) {
  return (
    <div className="pointer-events-none absolute bottom-24 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {prompts.map((p) => (
          <motion.div
            key={p.id}
            layout="position"
            initial={{ opacity: 0, y: 16, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 480, damping: 30 }}
            className="hud-glass rounded-full px-4 py-1.5 text-sm font-bold text-amber"
          >
            {p.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------ mobile controls ------------------------------ */

function MobileControls({ hud, input }: { hud: RefObject<HudData>; input: InputManager }) {
  const joyBaseRef = useRef<HTMLDivElement>(null);
  const joyKnobRef = useRef<HTMLDivElement>(null);
  const grabArcRef = useRef<SVGCircleElement>(null);
  const grabPulseRef = useRef<HTMLDivElement>(null);
  const grabBtnRef = useRef<HTMLButtonElement>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const wasHanging = useRef(false);
  const GRAB_R = 36;
  const GRAB_C = 2 * Math.PI * GRAB_R;

  useHudFrame(() => {
    const j = input.joystick;
    const base = joyBaseRef.current;
    const knob = joyKnobRef.current;
    if (base && knob) {
      if (j.active) {
        base.style.opacity = '1';
        base.style.transform = `translate(${j.ox - 60}px, ${j.oy - 60}px) scale(1)`;
        knob.style.transform = `translate(${j.dx}px, ${j.dy}px)`;
        const idle = performance.now() - j.lastActive > 2000;
        base.style.opacity = idle ? '0.4' : '1';
      } else {
        base.style.opacity = '0';
        base.style.transform = `translate(${j.ox - 60}px, ${j.oy - 60}px) scale(0.6)`;
      }
    }
    const d = hud.current;
    if (grabArcRef.current) {
      grabArcRef.current.style.strokeDashoffset = String(GRAB_C * (1 - Math.max(0, Math.min(1, d.stamina / 100))));
      grabArcRef.current.style.stroke = d.stamina < 25 ? '#C84B31' : '#E8A94C';
    }
    if (d.hanging && !wasHanging.current && grabPulseRef.current) {
      const el = grabPulseRef.current;
      el.classList.remove('hud-grab-pulse');
      void el.offsetWidth;
      el.classList.add('hud-grab-pulse');
    }
    wasHanging.current = d.hanging;
    if (grabBtnRef.current) grabBtnRef.current.style.opacity = d.exhausted ? '0.55' : '1';
    if (helpBtnRef.current) {
      // 拉手 context button: only when a hanging teammate below is in range
      helpBtnRef.current.style.display = d.helpAvailable ? 'flex' : 'none';
    }
  });

  return (
    <>
      <style>{`
        @keyframes hud-grab-pulse-anim { from { transform: scale(1); opacity: .8 } to { transform: scale(1.7); opacity: 0 } }
        .hud-grab-pulse { animation: hud-grab-pulse-anim 300ms ease-out both; }
      `}</style>
      {/* floating joystick */}
      <div
        ref={joyBaseRef}
        className="pointer-events-none absolute left-0 top-0 z-20 h-[120px] w-[120px] rounded-full border-2 border-snow/25 bg-snow/10 opacity-0 transition-opacity duration-150"
        style={{ transform: 'translate(-999px,-999px)' }}
      >
        <div
          ref={joyKnobRef}
          className="absolute left-1/2 top-1/2 -ml-[26px] -mt-[26px] h-[52px] w-[52px] rounded-full bg-snow/60"
        />
      </div>
      {/* bottom-right cluster: 抓取 (hold, left) + 跳 (tap, corner) */}
      <div
        className="pointer-events-auto absolute bottom-6 right-5 z-30 flex items-end"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="relative">
          <div ref={grabPulseRef} className="absolute inset-0 rounded-full border-4 border-amber opacity-0" />
          <button
            ref={grabBtnRef}
            type="button"
            aria-label="抓取"
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              e.preventDefault();
              input.setTouchGrab(true);
            }}
            onPointerUp={() => input.setTouchGrab(false)}
            onPointerCancel={() => input.setTouchGrab(false)}
            onPointerLeave={() => input.setTouchGrab(false)}
            className="relative flex items-center justify-center rounded-full border-2 border-amber/70 bg-amber/25 text-sm font-bold text-snow backdrop-blur-md transition-transform active:scale-[0.92] active:bg-amber/45"
            style={{ touchAction: 'none', width: 78, height: 78 }}
          >
            <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r={GRAB_R} fill="none" stroke="rgba(246,242,233,0.15)" strokeWidth="4" />
              <circle
                ref={grabArcRef}
                cx="40"
                cy="40"
                r={GRAB_R}
                fill="none"
                stroke="#E8A94C"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={GRAB_C}
              />
            </svg>
            抓取
          </button>
        </div>
        <button
          type="button"
          aria-label="跳"
          onPointerDown={(e) => {
            e.preventDefault();
            input.pressJump();
          }}
          className="-mb-2 -ml-4 flex h-16 w-16 items-center justify-center rounded-full border-2 border-snow/40 bg-snow/20 text-base font-bold text-snow backdrop-blur-md transition-transform active:scale-90 active:bg-snow/40"
          style={{ touchAction: 'none' }}
        >
          跳
        </button>
        {/* 拉手 (helping hand) — appears when a hanging teammate is below */}
        <button
          ref={helpBtnRef}
          type="button"
          aria-label="拉手"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            e.preventDefault();
            input.setTouchHelp(true);
          }}
          onPointerUp={() => input.setTouchHelp(false)}
          onPointerCancel={() => input.setTouchHelp(false)}
          onPointerLeave={() => input.setTouchHelp(false)}
          className="-mb-2 -ml-4 hidden h-16 w-16 items-center justify-center rounded-full border-2 border-amber/70 bg-amber/30 text-base font-bold text-snow backdrop-blur-md transition-transform active:scale-90 active:bg-amber/50"
          style={{ touchAction: 'none', display: 'none' }}
        >
          拉手
        </button>
      </div>
    </>
  );
}

/* ------------------------------ rotate hint ------------------------------ */

function RotateHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button type="button" onClick={onDismiss} className="pointer-events-auto absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-ink/70 backdrop-blur-sm">
      <motion.svg
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        animate={{ rotate: [-12, 12, -12] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <rect x="6" y="3" width="12" height="18" rx="2.5" stroke="#F6F2E9" strokeWidth="1.8" />
        <path d="M11 18h2" stroke="#F6F2E9" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M18.5 8a5.5 5.5 0 0 1 2 4M5.5 16a5.5 5.5 0 0 1-2-4" stroke="#E8A94C" strokeWidth="1.8" strokeLinecap="round" />
      </motion.svg>
      <div className="text-lg font-bold text-snow">横屏体验更佳</div>
      <div className="text-sm text-snow/60">轻触关闭</div>
    </button>
  );
}

/* -------------------------------- pause menu -------------------------------- */

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-snow/85">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn('h-6 w-11 rounded-full p-0.5 transition-colors', value ? 'bg-sage' : 'bg-snow/25')}
    >
      <span className={cn('block h-5 w-5 rounded-full bg-snow transition-transform', value && 'translate-x-5')} />
    </button>
  );
}

function PauseMenu({
  hud,
  seed,
  team,
  settings,
  multiplayer,
  isHost,
  isMobile,
  invite,
  multiplayerHint,
  actions,
}: {
  hud: RefObject<HudData>;
  seed: number;
  team: TeamEntry[];
  settings: Settings;
  multiplayer: boolean;
  isHost: boolean;
  isMobile: boolean;
  invite: InviteState | null;
  multiplayerHint: boolean;
  actions: HudActions;
}) {
  const [panel, setPanel] = useState<'main' | 'room' | 'settings'>('main');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [answer, setAnswer] = useState('');
  const d = hud.current;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-ink/55 p-4 backdrop-blur-[8px]"
    >
      <motion.div
        initial={{ scale: 0.92, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        className="hud-glass max-h-[86dvh] w-full max-w-[420px] overflow-y-auto rounded-3xl p-6"
      >
        <h2 className="font-zh text-2xl text-snow">休息一下</h2>
        <div className="mt-2 flex gap-4 font-mono text-sm text-amber">
          <span>{formatTime(d.timeMs)}</span>
          <span>{Math.max(0, Math.round(d.altitude))}m</span>
          <span>体力 {Math.round(d.stamina)}</span>
        </div>
        {multiplayerHint && multiplayer && (
          <div className="mt-3 rounded-xl bg-sky/20 px-3 py-2 text-xs text-snow/85">联机模式下世界不会暂停</div>
        )}

        {panel === 'main' && (
          <div className="mt-5 flex flex-col gap-3">
            {[
              <button key="resume" type="button" onClick={actions.resume} className="h-[52px] w-full rounded-full border-2 border-ink bg-terracotta font-btn font-semibold text-snow shadow-hard transition active:translate-y-0.5 active:shadow-hard-pressed">
                继续攀登
              </button>,
              <button key="respawn" type="button" onClick={actions.respawn} className="h-[52px] w-full rounded-full border-2 border-snow/40 bg-snow/10 font-btn font-semibold text-snow transition hover:bg-snow/20">
                回到营地
              </button>,
              <button key="room" type="button" onClick={() => setPanel('room')} className="h-[52px] w-full rounded-full border-2 border-snow/40 bg-snow/10 font-btn font-semibold text-snow transition hover:bg-snow/20">
                房间信息
              </button>,
              <button key="settings" type="button" onClick={() => setPanel('settings')} className="h-[52px] w-full rounded-full border-2 border-transparent font-btn font-semibold text-snow/85 transition hover:bg-snow/10">
                设置
              </button>,
              confirmLeave ? (
                <div key="leave" className="flex gap-2">
                  <button type="button" onClick={actions.leave} className="h-[52px] flex-1 rounded-full border-2 border-ink bg-danger font-btn font-semibold text-snow">
                    确定离开？
                  </button>
                  <button type="button" onClick={() => setConfirmLeave(false)} className="h-[52px] flex-1 rounded-full border-2 border-snow/40 font-btn font-semibold text-snow">
                    再想想
                  </button>
                </div>
              ) : (
                <button key="leaveask" type="button" onClick={() => setConfirmLeave(true)} className="h-[52px] w-full rounded-full font-btn font-semibold text-danger transition hover:bg-danger/15">
                  离开登山队
                </button>
              ),
            ].map((el, i) => (
              <motion.div key={el.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i }}>
                {el}
              </motion.div>
            ))}
          </div>
        )}

        {panel === 'room' && (
          <div className="mt-5 flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-xl bg-snow/10 px-3 py-2">
              <span className="text-sm text-snow/70">种子</span>
              <span className="font-mono text-sm font-bold text-amber">#{formatSeed(seed)}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {team.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-xl bg-snow/10 px-3 py-1.5 text-sm text-snow">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="font-bold">{p.name}</span>
                  {p.isHost && <span className="rounded-full bg-amber px-1.5 text-[0.6rem] font-bold leading-4 text-ink">房主</span>}
                  <span className="ml-auto font-mono text-xs text-amber">{Math.round(p.altitude)}m</span>
                </div>
              ))}
            </div>
            {isHost && (
              <div className="rounded-2xl bg-snow/95 p-3">
                <div className="mb-2 text-sm font-bold text-ink">邀请新队友</div>
                {invite?.offer ? (
                  <CodeBox mode="copy" value={invite.offer} label="邀请码（发给朋友）" rows={3} />
                ) : (
                  <button
                    type="button"
                    onClick={actions.makeInvite}
                    disabled={invite?.busy}
                    className="h-10 w-full rounded-full border-2 border-ink bg-terracotta text-sm font-bold text-snow disabled:opacity-50"
                  >
                    {invite?.busy ? '生成中…' : '生成邀请码'}
                  </button>
                )}
                <div className="mt-3">
                  <CodeBox mode="paste" value={answer} onChange={setAnswer} label="应答码（朋友发回）" placeholder="粘贴应答码…" rows={3} />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (answer.trim()) actions.acceptAnswer(answer.trim());
                  }}
                  disabled={!answer.trim() || invite?.busy}
                  className="mt-2 h-10 w-full rounded-full border-2 border-ink bg-sage text-sm font-bold text-ink disabled:opacity-50"
                >
                  {invite?.busy ? '连接中…' : '接受应答'}
                </button>
                {invite?.error && <div className="mt-2 text-xs font-bold text-danger">{invite.error}</div>}
              </div>
            )}
            <button type="button" onClick={() => setPanel('main')} className="h-11 rounded-full border-2 border-snow/40 font-btn text-sm font-semibold text-snow">
              返回
            </button>
          </div>
        )}

        {panel === 'settings' && (
          <div className="mt-5 flex flex-col gap-1">
            <SettingRow label={`灵敏度 ${settings.sensitivity.toFixed(2)}`}>
              <input
                type="range"
                min={0.3}
                max={2.5}
                step={0.05}
                value={settings.sensitivity}
                onChange={(e) => actions.settingsChange({ sensitivity: Number(e.target.value) })}
                className="w-36 accent-amber"
              />
            </SettingRow>
            <SettingRow label="反转 Y 轴">
              <Toggle value={settings.invertY} onChange={(v) => actions.settingsChange({ invertY: v })} />
            </SettingRow>
            {isMobile && (
              <SettingRow label="陀螺仪">
                <Toggle value={settings.gyroEnabled} onChange={(v) => actions.settingsChange({ gyroEnabled: v })} />
              </SettingRow>
            )}
            <SettingRow label="画质">
              <select
                value={settings.quality}
                onChange={(e) => actions.settingsChange({ quality: e.target.value as Settings['quality'] })}
                className="rounded-lg border border-snow/30 bg-ink/60 px-2 py-1 text-sm text-snow"
              >
                <option value="auto">自动</option>
                <option value="low">流畅</option>
                <option value="medium">均衡</option>
                <option value="high">极致</option>
              </select>
            </SettingRow>
            <SettingRow label={`音量 ${Math.round(settings.volume * 100)}%`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.volume}
                onChange={(e) => actions.settingsChange({ volume: Number(e.target.value) })}
                className="w-36 accent-amber"
              />
            </SettingRow>
            <SettingRow label="减少动态效果">
              <Toggle value={settings.reducedMotion} onChange={(v) => actions.settingsChange({ reducedMotion: v })} />
            </SettingRow>
            <button type="button" onClick={() => setPanel('main')} className="mt-3 h-11 rounded-full border-2 border-snow/40 font-btn text-sm font-semibold text-snow">
              返回
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------ respawn overlay ------------------------------ */

function RespawnOverlay({ name }: { name: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#1a120c]/85">
      <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 320, damping: 24 }} className="hud-glass flex flex-col items-center gap-3 rounded-3xl px-10 py-8 text-center">
        <motion.span animate={{ rotate: 720 }} transition={{ duration: 1, ease: 'easeOut' }} className="text-amber">
          <IconCompass size={40} />
        </motion.span>
        <div className="text-lg font-bold text-snow">巡逻队把你带回了营地</div>
        <div className="font-mono text-sm text-amber">{name}</div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------ victory overlay ------------------------------ */

function VictoryOverlay({ data, onAgain, onLobby }: { data: VictoryData; onAgain: () => void; onLobby: () => void }) {
  const [shownMs, setShownMs] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const roll = () => {
      const k = Math.min(1, (performance.now() - t0) / 1200);
      const eased = 1 - Math.pow(1 - k, 3);
      setShownMs(data.timeMs * eased);
      if (k < 1) raf = requestAnimationFrame(roll);
    };
    raf = requestAnimationFrame(roll);
    return () => cancelAnimationFrame(raf);
  }, [data.timeMs]);
  const climbing = data.teammates.filter((t) => !t.isSelf && !t.summited);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.6 }}
      className="pointer-events-auto absolute inset-0 z-40 flex items-end justify-center bg-gradient-to-t from-[#1a120c]/90 via-[#1a120c]/40 to-transparent p-4 pb-10"
    >
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.75, type: 'spring', stiffness: 260, damping: 26 }}
        className="flex w-full max-w-[520px] flex-col items-center gap-4 text-center"
      >
        <div>
          <div className="font-latin text-sm font-semibold tracking-[0.35em] text-amber">SUMMIT</div>
          <h2 className="font-zh text-display-lg text-snow" style={{ textShadow: '0 4px 24px rgba(24,17,10,.6)' }}>
            登顶成功！
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-5xl font-bold text-snow">{formatTimeCs(shownMs)}</span>
          {data.isRecord ? (
            <motion.span initial={{ scale: 0, rotate: -14 }} animate={{ scale: 1, rotate: -4 }} transition={{ delay: 1.3, type: 'spring', stiffness: 420, damping: 18 }}>
              <motion.span
                animate={{ rotate: [-4, -1, -4] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', delay: 1.6 }}
                className="inline-block rounded-full bg-amber px-3 py-1 text-sm font-bold text-ink"
              >
                新纪录！
              </motion.span>
            </motion.span>
          ) : (
            data.bestMs != null && <span className="font-mono text-sm text-snow/70">最佳 {formatTime(data.bestMs)}</span>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {[`海拔 ${Math.round(data.altitude)}m`, `检查点 ${data.checkpoints}`, `坠落 ${data.falls} 次`, `队友 ${data.players - 1}人`].map((s, i) => (
            <motion.span
              key={s}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1 + i * 0.08 }}
              className="hud-glass rounded-full px-3 py-1 text-sm font-bold text-snow"
            >
              {s}
            </motion.span>
          ))}
        </div>
        {data.unlocks.length > 0 && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 1.4, type: 'spring', stiffness: 380, damping: 20 }}
            className="rounded-full bg-sage px-4 py-1.5 text-sm font-bold text-ink"
          >
            解锁新装扮：{data.unlocks.map((u) => COSMETIC_ZH[u] ?? u).join('、')}！
          </motion.div>
        )}
        <div className="mt-2 flex w-full flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onAgain}
            disabled={!data.canRestart}
            className="h-14 flex-1 rounded-full border-2 border-ink bg-terracotta font-btn text-lg font-semibold text-snow shadow-hard transition active:translate-y-0.5 active:shadow-hard-pressed disabled:opacity-60"
          >
            {data.canRestart ? '再来一座山' : '等待房主开新局…'}
          </button>
          <button type="button" onClick={onLobby} className="h-14 flex-1 rounded-full border-2 border-snow/50 bg-snow/10 font-btn text-lg font-semibold text-snow backdrop-blur-md transition hover:bg-snow/20">
            返回大厅
          </button>
        </div>
        {climbing.length > 0 && (
          <div className="text-sm text-snow/70">
            {climbing.map((t) => `${t.name} 还在 ${Math.round(t.altitude)}m 努力…`).join(' · ')}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------ context lost ------------------------------ */

function ContextLostCard() {
  return (
    <div className="pointer-events-auto absolute inset-0 z-[60] flex items-center justify-center bg-ink">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="font-zh text-2xl text-snow">渲染出错</div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-12 rounded-full border-2 border-ink bg-terracotta px-8 font-btn font-semibold text-snow"
        >
          点击重新加载
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- tab players ------------------------------- */

function TabPanel({ team }: { team: TeamEntry[] }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-30 w-[300px] -translate-x-1/2 -translate-y-1/2">
      <div className="hud-glass flex flex-col gap-2 rounded-2xl p-4">
        <div className="text-center text-sm font-bold tracking-widest text-snow/70">登山队</div>
        {team.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 rounded-xl bg-snow/10 px-3 py-2 text-snow">
            <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="font-bold">
              {p.name}
              {p.isSelf && <span className="ml-1 text-snow/60">（我）</span>}
            </span>
            {p.isHost && <span className="rounded-full bg-amber px-1.5 text-[0.6rem] font-bold leading-4 text-ink">房主</span>}
            <span className="ml-auto font-mono text-xs text-amber">{Math.round(p.altitude)}m</span>
            {typeof p.ping === 'number' && <span className="font-mono text-xs text-snow/60">{Math.round(p.ping)}ms</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- root HUD --------------------------------- */

export interface GameHudProps {
  hud: RefObject<HudData>;
  input: InputManager | null;
  isMobile: boolean;
  phase: GamePhase;
  loading: LoadingInfo;
  wiping: boolean;
  seed: number;
  bestMs: number | null;
  paused: boolean;
  solo: boolean;
  isHost: boolean;
  multiplayer: boolean;
  respawnName: string | null;
  team: TeamEntry[];
  myPing: number | null;
  prompts: Prompt[];
  checkpoints: CheckpointTick[];
  heightM: number;
  victory: VictoryData | null;
  settings: Settings;
  gyroOn: boolean;
  contextLost: boolean;
  showPlayers: boolean;
  invite: InviteState | null;
  selfEmote: { kind: EmoteKind; at: number } | null;
  multiplayerHint: boolean;
  hostLeftBanner: boolean;
  actions: HudActions;
}

export function GameHud(props: GameHudProps) {
  const {
    hud,
    input,
    isMobile,
    phase,
    loading,
    wiping,
    seed,
    bestMs,
    paused,
    solo,
    isHost,
    multiplayer,
    respawnName,
    team,
    myPing,
    prompts,
    checkpoints,
    heightM,
    victory,
    settings,
    gyroOn,
    contextLost,
    showPlayers,
    invite,
    selfEmote,
    multiplayerHint,
    hostLeftBanner,
    actions,
  } = props;
  const [rotateDismissed, setRotateDismissed] = useState(false);
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    if (!isMobile) return;
    const mq = window.matchMedia('(orientation: portrait)');
    const update = () => setPortrait(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [isMobile]);

  const SelfEmoteIcon = selfEmote ? EMOTES.find((e) => e.kind === selfEmote.kind)?.icon : null;

  return (
    <div
      className="pointer-events-none absolute inset-0 select-none"
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      <style>{`@keyframes hud-enter { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }`}</style>
      {hostLeftBanner && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="pointer-events-none absolute left-1/2 top-16 z-40 -translate-x-1/2 rounded-full border border-amber/60 bg-amber/90 px-4 py-1.5 text-sm font-bold text-ink"
        >
          房主已离开，已切换为单人模式
        </motion.div>
      )}
      {phase === 'playing' && !victory && (
        <>
          <Crosshair hud={hud} />
          <div className="pointer-events-none absolute inset-0" style={{ animation: 'hud-enter .35s ease-out both' }}>
            <TopCenter hud={hud} compact={isMobile} />
          </div>
          <div className="pointer-events-none absolute inset-0" style={{ animation: 'hud-enter .35s ease-out .12s both' }}>
            <TeamChips team={team} compact={isMobile} />
          </div>
          {/* top-right cluster */}
          <div
            className={cn('absolute z-30 flex items-center gap-2', isMobile ? 'right-2 top-2' : 'right-5 top-4')}
            style={{ animation: 'hud-enter .35s ease-out .18s both', marginTop: isMobile ? 'env(safe-area-inset-top)' : undefined }}
          >
            <PingBadge solo={solo} ping={myPing} />
            {isMobile && (
              <button
                type="button"
                title="陀螺仪"
                onClick={actions.gyroToggle}
                className={cn(
                  'hud-glass pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-snow',
                  gyroOn && 'ring-2 ring-sage text-sage',
                )}
              >
                <IconCompass />
              </button>
            )}
            <button
              type="button"
              title="暂停"
              onClick={actions.pause}
              className="hud-glass pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-snow"
            >
              <IconPause />
            </button>
          </div>
          <div className="pointer-events-none absolute inset-0" style={{ animation: 'hud-enter .35s ease-out .24s both' }}>
            <AltitudeMeter hud={hud} team={team} checkpoints={checkpoints} heightM={heightM} slim={isMobile} />
          </div>
          {!isMobile && (
            <div className="pointer-events-none absolute inset-0" style={{ animation: 'hud-enter .35s ease-out .3s both' }}>
              <KeyHints hud={hud} />
            </div>
          )}
          <div className="pointer-events-none absolute inset-0" style={{ animation: 'hud-enter .35s ease-out .3s both' }}>
            <EmoteBar onEmote={actions.emote} compact={isMobile} />
          </div>
          {isMobile && input && <MobileControls hud={hud} input={input} />}
          {showPlayers && <TabPanel team={team} />}
          {selfEmote && SelfEmoteIcon && (
            <motion.div
              key={selfEmote.at}
              initial={{ opacity: 0, scale: 0.4, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 20 }}
              className="hud-glass pointer-events-none absolute bottom-36 left-1/2 z-20 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full text-amber"
            >
              <SelfEmoteIcon />
            </motion.div>
          )}
        </>
      )}
      <Prompts prompts={prompts} />
      <AnimatePresence>{respawnName && <RespawnOverlay key="respawn" name={respawnName} />}</AnimatePresence>
      <AnimatePresence>
        {paused && phase === 'playing' && !victory && (
          <PauseMenu
            key="pause"
            hud={hud}
            seed={seed}
            team={team}
            settings={settings}
            multiplayer={multiplayer}
            isHost={isHost}
            isMobile={isMobile}
            invite={invite}
            multiplayerHint={multiplayerHint}
            actions={actions}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>{victory && <VictoryOverlay key="victory" data={victory} onAgain={actions.again} onLobby={actions.backToLobby} />}</AnimatePresence>
      <AnimatePresence>{phase === 'ready' && <ReadyGate key="ready" isMobile={isMobile} onStart={actions.start} />}</AnimatePresence>
      {phase === 'boot' && <LoadingScreen loading={loading} seed={seed} bestMs={bestMs} wiping={wiping} onDone={actions.loadingDone} />}
      {isMobile && portrait && !rotateDismissed && phase === 'playing' && <RotateHint onDismiss={() => setRotateDismissed(true)} />}
      {contextLost && <ContextLostCard />}
    </div>
  );
}
