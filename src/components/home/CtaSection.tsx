import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { cn } from '@/lib/utils';

gsap.registerPlugin(ScrollTrigger);

/**
 * §8 Final CTA 顶峰相见 — summit photo backdrop with parallax scrub, kinetic
 * title, glowing CTA button and a ripple ring on click before navigating.
 * (GSAP only in this component.)
 */

function splitChars(el: HTMLElement): HTMLElement[] {
  const text = el.textContent ?? '';
  el.textContent = '';
  el.setAttribute('aria-label', text);
  const spans: HTMLElement[] = [];
  for (const ch of text) {
    const s = document.createElement('span');
    s.textContent = ch === ' ' ? ' ' : ch;
    s.style.display = 'inline-block';
    s.style.willChange = 'transform';
    s.setAttribute('aria-hidden', 'true');
    el.appendChild(s);
    spans.push(s);
  }
  return spans;
}

export default function CtaSection() {
  const rootRef = useRef<HTMLElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const [ripple, setRipple] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = gsap.context(() => {
      if (!reduced) {
        // bg parallax scrub (y −8% → 0)
        gsap.fromTo(
          bgRef.current,
          { yPercent: -8 },
          {
            yPercent: 0,
            ease: 'none',
            scrollTrigger: { trigger: root, start: 'top bottom', end: 'bottom top', scrub: true },
          },
        );
        // title char pop
        if (titleRef.current) {
          const chars = splitChars(titleRef.current);
          gsap.from(chars, {
            y: 36,
            scale: 0.8,
            opacity: 0,
            stagger: 0.05,
            duration: 0.6,
            ease: 'back.out(2)',
            scrollTrigger: { trigger: root, start: 'top 70%', once: true },
          });
        }
        // button spring in
        const btn = stackRef.current?.querySelector('[data-cta]');
        if (btn) {
          gsap.from(btn, {
            scale: 0.8,
            opacity: 0,
            duration: 0.6,
            ease: 'back.out(2.4)',
            scrollTrigger: { trigger: root, start: 'top 55%', once: true },
          });
        }
      }
    }, root);
    return () => ctx.revert();
  }, []);

  const go = () => {
    if (ripple) return;
    setRipple(true);
    setTimeout(() => navigate('/lobby'), 300);
  };

  return (
    <section ref={rootRef} className="relative flex min-h-[480px] items-center justify-center overflow-hidden">
      {/* parallax backdrop */}
      <div
        ref={bgRef}
        className="absolute inset-x-0 -top-[12%] h-[124%] bg-cover bg-center will-change-transform"
        style={{ backgroundImage: 'url(/cta-summit.svg)' }}
        aria-hidden
      />
      {/* dark warm overlay gradient */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-ink/25 via-transparent to-ink/70"
        aria-hidden
      />

      <div ref={stackRef} className="relative z-10 flex flex-col items-center px-6 py-24 text-center">
        <h2 ref={titleRef} className="font-zh text-display-lg text-snow drop-shadow-[0_4px_16px_rgba(46,36,24,.45)]">
          顶峰相见
        </h2>
        <p className="mt-4 text-lg font-medium text-snow/90 drop-shadow-[0_2px_8px_rgba(46,36,24,.5)]">
          叫上朋友，现在就开始攀登。
        </p>
        <button
          type="button"
          data-cta
          onClick={go}
          className={cn(
            'btn-hard relative mt-9 h-16 overflow-visible rounded-full border-2 border-ink bg-terracotta px-12 font-btn text-xl font-semibold text-snow',
            'transition-shadow duration-300 hover:shadow-glow',
          )}
        >
          <span className="relative z-10 flex items-center gap-2">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden className="transition-transform duration-300 group-hover:rotate-6">
              <path d="M11 2l7.5 17h-15L11 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <path d="M11 2v6" stroke="currentColor" strokeWidth="2" />
            </svg>
            开始游戏
          </span>
          {/* click ripple ring */}
          {ripple && (
            <span
              className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-amber"
              style={{ animation: 'cta-ripple 300ms ease-out forwards' }}
              aria-hidden
            />
          )}
        </button>
        <div className="mt-6 font-mono text-xs tracking-wide text-snow/75">无需注册 · 打开即玩</div>
      </div>
      <style>{`@keyframes cta-ripple { from { transform: translate(-50%,-50%) scale(1); opacity: .9; } to { transform: translate(-50%,-50%) scale(7); opacity: 0; } }`}</style>
    </section>
  );
}
