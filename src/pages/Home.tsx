import { lazy, Suspense, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import HeroPoster from '@/components/HeroPoster';
import Footer from '@/components/Footer';
import Button from '@/components/Button';
import Card from '@/components/Card';
import { scrollToSection } from '@/lib/scroll';
import { cn } from '@/lib/utils';
import StaminaDemo from '@/components/home/StaminaDemo';
import ControlsTabs from '@/components/home/ControlsTabs';
import CtaSection from '@/components/home/CtaSection';

gsap.registerPlugin(ScrollTrigger);

// HeroMountain pulls in all of Three.js — code-split it out of the landing
// chunk; show the static poster while the async chunk loads.
const HeroMountain = lazy(() => import('@/components/HeroMountain'));

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Split an element's text into per-char spans for kinetic type reveals. */
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

function Eyebrow({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'font-latin text-sm font-semibold uppercase tracking-[0.3em] text-terracotta sm:text-base',
        className,
      )}
    >
      {children}
    </div>
  );
}

function TrailDivider({ className }: { className?: string }) {
  return <div className={cn('mx-auto mt-5 w-24 border-t-2 border-dashed border-line', className)} aria-hidden />;
}

/* ------------------------------------------------------------------ */
/* §1 Hero — real-time 3D mountain                                     */
/* ------------------------------------------------------------------ */

function HeroSection() {
  const rootRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const eyebrowRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLParagraphElement>(null);
  const btnsRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef(0); // 0..1 pin progress → HeroMountain

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = reducedMotion();
    const ctx = gsap.context(() => {
      if (!reduced) {
        /* ---- load choreography (home.md §1 Animation/Load) ---- */
        const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
        if (eyebrowRef.current) {
          const words = splitChars(eyebrowRef.current);
          tl.from(words, { yPercent: 110, opacity: 0, stagger: 0.03, duration: 0.6 }, 0.35);
        }
        if (titleRef.current) {
          const chars = splitChars(titleRef.current);
          tl.from(
            chars,
            {
              y: 40,
              scale: 0.7,
              opacity: 0,
              stagger: 0.06,
              duration: 0.7,
              ease: 'back.out(2.2)',
            },
            0.45,
          );
        }
        if (chipsRef.current) {
          tl.from(chipsRef.current.children, { y: 18, opacity: 0, stagger: 0.07, duration: 0.45 }, 0.6);
        }
        if (subRef.current) tl.from(subRef.current, { y: 20, opacity: 0, duration: 0.55 }, 0.7);
        if (btnsRef.current) tl.from(btnsRef.current.children, { y: 24, opacity: 0, stagger: 0.08, duration: 0.5 }, 0.7);
        if (noteRef.current) tl.from(noteRef.current, { y: 12, opacity: 0, duration: 0.5 }, 0.9);
        if (hintRef.current) tl.from(hintRef.current, { opacity: 0, duration: 0.6 }, 1.1);

        /* ---- scroll scrub: pin 150vh, title parallax up + fade ---- */
        gsap
          .timeline({
            scrollTrigger: {
              trigger: root,
              start: 'top top',
              end: '+=150%',
              pin: true,
              scrub: true,
              onUpdate: (self) => {
                scrollRef.current = self.progress;
              },
            },
          })
          .to(contentRef.current, { y: -80, opacity: 0, ease: 'none', duration: 0.6 }, 0)
          .to(hintRef.current, { opacity: 0, ease: 'none', duration: 0.15 }, 0);
      } else {
        // reduced motion: no pin/splits — everything simply visible
        gsap.set([contentRef.current, hintRef.current], { opacity: 1 });
      }
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={rootRef} className="relative -mt-16 h-[100dvh] min-h-[560px] overflow-hidden" aria-label="攀峰首页主视觉">
      {/* 3D canvas (poster while the chunk loads / when WebGL is unavailable) */}
      <Suspense fallback={<HeroPoster />}>
        <HeroMountain scrollRef={scrollRef} />
      </Suspense>
      {/* soft paper gradient at the bottom edge to blend into the next section */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-b from-transparent to-paper/80" aria-hidden />

      {/* content stack */}
      <div className="relative z-10 mx-auto flex h-full max-w-content items-center px-6">
        <div ref={contentRef} className="max-w-[640px] text-center md:text-left">
          <div ref={chipsRef} className="mb-5 flex flex-wrap justify-center gap-2 md:justify-start">
            <span className="rounded-full border-2 border-ink/60 bg-sky/70 px-3.5 py-1 text-xs font-bold text-ink">P2P 联机</span>
            <span className="rounded-full border-2 border-ink/60 bg-amber/70 px-3.5 py-1 text-xs font-bold text-ink">随机山峰</span>
            <span className="rounded-full border-2 border-ink/60 bg-sage/70 px-3.5 py-1 text-xs font-bold text-ink">无需下载</span>
          </div>
          <div ref={eyebrowRef} className="font-latin text-sm font-semibold uppercase tracking-[0.3em] text-terracotta sm:text-lg">
            SUMMIT TOGETHER
          </div>
          <h1 ref={titleRef} className="mt-2 font-zh text-display-xl leading-[1.05] text-ink">
            攀峰
          </h1>
          <p ref={subRef} className="mx-auto mt-5 max-w-[480px] text-[1.0625rem] leading-[1.7] text-ink-soft md:mx-0">
            一款基于 Three.js 的在线多人攀爬小游戏 —— 和朋友一起，登上随机生成的山顶。
          </p>
          <div ref={btnsRef} className="mt-8 flex flex-wrap items-center justify-center gap-4 md:justify-start">
            <Button to="/lobby" size="lg" className="h-[60px]">
              开始游戏
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="h-[60px]"
              onClick={() => scrollToSection('howto')}
            >
              怎么玩
            </Button>
          </div>
          <div ref={noteRef} className="mt-6 font-mono text-xs tracking-wide text-ink-soft">
            WebRTC 直连 · 数据只存在你的浏览器里
          </div>
        </div>
      </div>

      {/* scroll hint */}
      <div ref={hintRef} className="absolute inset-x-0 bottom-7 z-10 flex flex-col items-center gap-2">
        <div className="h-8 border-l-2 border-dashed border-ink/40" aria-hidden />
        <span className="text-xs font-bold text-ink-soft">向下滚动</span>
        <svg className="animate-scroll-cue text-ink" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <path d="M4 7l5 5 5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §2 Feature ticker marquee                                           */
/* ------------------------------------------------------------------ */

const TICKER_ITEMS = ['随机生成山峰', 'WebRTC P2P 联机', '键鼠 · 触屏 · 陀螺仪', 'IndexedDB 本地存档', '无需服务器', '和朋友一起登顶'];

function TickerSection() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = gsap.context(() => {
      gsap.from(el, {
        y: 40,
        rotate: -3,
        opacity: 0,
        duration: 0.7,
        ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 90%', once: true },
      });
    }, el);
    return () => ctx.revert();
  }, []);

  const row = (
    <div className="flex shrink-0 items-center">
      {TICKER_ITEMS.map((t) => (
        <span key={t} className="flex items-center whitespace-nowrap text-lg font-semibold text-snow">
          <span className="px-5">{t}</span>
          <span className="text-amber">✦</span>
        </span>
      ))}
    </div>
  );

  return (
    <div ref={ref} className="relative z-20 -mt-9 h-[72px] -rotate-[1.2deg] overflow-hidden border-y-2 border-dashed border-amber bg-ink">
      <div className="flex h-full w-max animate-marquee items-center hover:[animation-play-state:paused]">
        {row}
        {row}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* §3 How to play — 3 steps                                            */
/* ------------------------------------------------------------------ */

const HOWTO = [
  {
    img: '/howto-1.svg',
    badge: '01',
    title: '创建房间，复制邀请码',
    body: '房主一键创建房间，把邀请码发给好友 —— 不需要注册，不需要服务器。',
  },
  {
    img: '/howto-2.svg',
    badge: '02',
    title: '好友粘贴，即刻加入',
    body: '好友在大厅粘贴邀请码，回传应答码，WebRTC 直连建立，最多 4 人同行。',
  },
  {
    img: '/howto-3.svg',
    badge: '03',
    title: '一起攀登，顶峰相见',
    body: '同一片随机生成的山，管理好体力，踩着岩点向上 —— 把旗插上顶峰！',
  },
];

function HowToSection() {
  const rootRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<SVGPathElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = reducedMotion();
    const ctx = gsap.context(() => {
      if (!reduced && titleRef.current) {
        const chars = splitChars(titleRef.current);
        gsap.from(chars, {
          y: 30,
          opacity: 0,
          stagger: 0.08,
          duration: 0.55,
          ease: 'power3.out',
          scrollTrigger: { trigger: titleRef.current, start: 'top 75%', once: true },
        });
      }
      if (cardsRef.current) {
        const cards = Array.from(cardsRef.current.children) as HTMLElement[];
        if (!reduced) {
          gsap.from(cards, {
            y: 60,
            opacity: 0,
            rotate: (i) => (i % 2 === 0 ? -1.5 : 1.5),
            stagger: 0.15,
            duration: 0.65,
            ease: 'power3.out',
            scrollTrigger: { trigger: cardsRef.current, start: 'top 70%', once: true },
          });
          cards.forEach((card, i) => {
            const badge = card.querySelector('[data-badge]');
            if (badge) {
              gsap.from(badge, {
                scale: 0,
                duration: 0.4,
                ease: 'back.out(2.5)',
                scrollTrigger: { trigger: cardsRef.current, start: 'top 70%', once: true },
                delay: 0.3 + i * 0.15,
              });
            }
          });
        }
      }
      if (trailRef.current && !reduced) {
        const path = trailRef.current;
        const len = path.getTotalLength();
        gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
        gsap.to(path, {
          strokeDashoffset: 0,
          ease: 'none',
          scrollTrigger: {
            trigger: cardsRef.current,
            start: 'top 75%',
            end: 'bottom 45%',
            scrub: true,
          },
        });
      }
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={rootRef} id="howto" className="relative mx-auto max-w-content scroll-mt-20 px-6 py-24 md:py-32">
      <div className="text-center">
        <Eyebrow>HOW TO PLAY</Eyebrow>
        <h2 ref={titleRef} className="mt-3 font-zh text-display-lg text-ink">
          三步，一起上山
        </h2>
        <TrailDivider />
      </div>

      <div ref={cardsRef} className="relative mt-14 grid gap-8 md:grid-cols-3 md:gap-6 lg:gap-10">
        {/* dashed trail winding between cards (desktop) */}
        <svg
          className="pointer-events-none absolute inset-x-0 -top-8 hidden h-24 w-full md:block"
          viewBox="0 0 1200 100"
          fill="none"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            ref={trailRef}
            d="M40 70 C 220 20, 340 90, 520 55 S 900 15, 1160 60"
            stroke="#D0713F"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="0"
            opacity="0.55"
          />
        </svg>
        {HOWTO.map((s) => (
          <Card
            key={s.badge}
            hoverable
            radius="lg"
            className="group relative overflow-hidden p-0"
            onClick={() => navigate('/lobby')}
          >
            <div className="relative overflow-hidden">
              <img
                src={s.img}
                alt={s.title}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover transition-transform duration-500 ease-spring group-hover:scale-[1.04]"
              />
              <span
                data-badge
                className="absolute left-4 top-4 flex h-11 w-11 items-center justify-center rounded-full border-2 border-ink bg-amber font-latin text-sm font-bold text-ink shadow-hard-sm"
              >
                {s.badge}
              </span>
            </div>
            <div className="p-6">
              <h3 className="text-xl font-bold text-ink">{s.title}</h3>
              <p className="mt-2.5 text-[0.95rem] leading-relaxed text-ink-soft">{s.body}</p>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §4 Features — 2×2 grid                                              */
/* ------------------------------------------------------------------ */

const FEATURES = [
  {
    title: '每一局都是新山',
    body: '种子驱动的程序化生成：同一房间所有人看到同一座山，换局换种子，百爬不厌。',
    spec: 'seeded PRNG · mulberry32',
    tint: 'bg-amber/30',
    tintHover: 'group-hover:bg-amber/60',
    icon: (
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden>
        <path d="M3 24 11 9l4.5 7L19 11l8 13H3Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
        <path d="M22 5.5c1.8 0 3.5 1.2 4 3M26 4v4h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: '像 PEAK 一样管理体力',
    body: '抓握会持续消耗体力，在平台上喘息、规划下一段路线。体力见底，就会脱手坠落。',
    spec: 'stamina 100 · hang −2.5/s',
    tint: 'bg-terracotta/25',
    tintHover: 'group-hover:bg-terracotta/50',
    icon: (
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden>
        <rect x="3" y="10" width="21" height="11" rx="3" stroke="currentColor" strokeWidth="2.2" />
        <path d="M27 13.5v4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M7 14.5v2M11 14.5v2M15 14.5v2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: '复制粘贴就能联机',
    body: '原生 WebRTC DataChannel 点对点直连，邀请码即服务器。房主中继，最多 4 人同攀。',
    spec: 'RTCPeerConnection · star',
    tint: 'bg-sky/35',
    tintHover: 'group-hover:bg-sky/70',
    icon: (
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="22" cy="22" r="4" stroke="currentColor" strokeWidth="2.2" />
        <path d="M11.5 11.5 18.5 18.5M22 8h-5.5c-4 0-4 5-8.5 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: '电脑手机，随时开爬',
    body: '键鼠、虚拟摇杆、触屏拖拽视角，还能一键开启陀螺仪环视。数据存进 IndexedDB。',
    spec: 'touch + gyro · IndexedDB',
    tint: 'bg-sage/30',
    tintHover: 'group-hover:bg-sage/60',
    icon: (
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden>
        <rect x="2.5" y="8" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2.2" />
        <path d="M6 12h.01M10 12h.01M14 12h.01M6 15.5h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <rect x="20.5" y="4" width="7" height="22" rx="2" stroke="currentColor" strokeWidth="2.2" />
        <path d="M23.5 22.5h1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
];

function FeaturesSection() {
  const rootRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = reducedMotion();
    const ctx = gsap.context(() => {
      if (reduced || !gridRef.current) return;
      const cards = Array.from(gridRef.current.children) as HTMLElement[];
      const tl = gsap.timeline({
        scrollTrigger: { trigger: gridRef.current, start: 'top 70%', once: true },
      });
      tl.from(cards, { y: 48, opacity: 0, stagger: 0.12, duration: 0.6, ease: 'power3.out' }).from(
        cards.map((c) => c.querySelector('[data-icon]')).filter(Boolean),
        { scale: 0.5, rotate: -8, duration: 0.5, ease: 'back.out(2.4)', stagger: 0.12 },
        0.15,
      );
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={rootRef} id="features" className="scroll-mt-20 border-y-2 border-dashed border-line bg-paper-deep">
      <div className="mx-auto max-w-content px-6 py-24 md:py-32">
        <div className="max-w-xl">
          <Eyebrow>FEATURES</Eyebrow>
          <h2 className="mt-3 font-zh text-display-lg text-ink">为什么好玩</h2>
          <TrailDivider className="mx-0" />
        </div>

        <div ref={gridRef} className="mt-12 grid gap-6 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <Card
              key={f.title}
              hoverable
              className="group cursor-pointer bg-paper p-7"
              onClick={() => navigate('/lobby')}
            >
              <div
                data-icon
                className={cn(
                  'flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-ink/15 text-ink transition-all duration-300 ease-spring group-hover:rotate-6',
                  f.tint,
                  f.tintHover,
                )}
              >
                {f.icon}
              </div>
              <h3 className="mt-5 text-xl font-bold text-ink">{f.title}</h3>
              <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-soft">{f.body}</p>
              <div className="mt-4 font-mono text-xs tracking-wide text-ink-soft/70">{f.spec}</div>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §7 Trust strip — 数据与隐私                                          */
/* ------------------------------------------------------------------ */

const STATS = [
  { value: 0, display: '0', unit: '服务器', sub: '房间码即连接' },
  { value: 100, display: '100%', unit: '本地', sub: '战绩与设置只存 IndexedDB' },
  { value: 42, display: '42亿', unit: '座山', sub: '42 亿种随机种子' },
];

function StatsSection() {
  const rootRef = useRef<HTMLElement>(null);
  const numsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = reducedMotion();
    const ctx = gsap.context(() => {
      if (!numsRef.current) return;
      const blocks = Array.from(numsRef.current.children) as HTMLElement[];
      if (reduced) return;
      gsap.from(blocks, {
        y: 28,
        opacity: 0,
        stagger: 0.1,
        duration: 0.55,
        ease: 'power3.out',
        scrollTrigger: { trigger: numsRef.current, start: 'top 80%', once: true },
      });
      blocks.forEach((block, i) => {
        const el = block.querySelector('[data-count]');
        const target = STATS[i].value;
        if (!el || target === 0) return;
        const obj = { v: 0 };
        gsap.to(obj, {
          v: target,
          duration: 1,
          ease: 'power2.out',
          scrollTrigger: { trigger: numsRef.current, start: 'top 80%', once: true },
          onUpdate: () => {
            el.textContent = String(Math.round(obj.v));
          },
          onComplete: () => {
            el.textContent = STATS[i].display.replace(/[0-9.]+$/, String(target));
          },
        });
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={rootRef} className="mx-auto max-w-content px-6 py-16">
      <div ref={numsRef} className="grid gap-10 text-center sm:grid-cols-3 sm:gap-0">
        {STATS.map((s, i) => (
          <div
            key={s.unit}
            className={cn('flex flex-col items-center gap-1 px-6', i > 0 && 'sm:border-l-2 sm:border-dashed sm:border-line')}
          >
            <div className="font-latin text-5xl font-bold text-ink">
              <span data-count>{s.display}</span>
            </div>
            <div className="text-lg font-bold text-terracotta">{s.unit}</div>
            <div className="text-sm text-ink-soft">{s.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Home page                                                           */
/* ------------------------------------------------------------------ */

export default function Home() {
  const location = useLocation();

  /* Lenis smooth scroll (landing only) + ScrollTrigger sync (design §6) */
  useEffect(() => {
    const reduced = reducedMotion();
    if (reduced) return;
    const lenis = new Lenis({ lerp: 0.09 });
    (window as unknown as { __lenis?: Lenis }).__lenis = lenis;
    lenis.on('scroll', ScrollTrigger.update);
    let rafId = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };
    rafId = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      delete (window as unknown as { __lenis?: Lenis }).__lenis;
    };
  }, []);

  /* hash deep-links (/#howto etc.) from other routes */
  useEffect(() => {
    if (location.hash) {
      const id = location.hash.slice(1);
      const t = setTimeout(() => scrollToSection(id), 350);
      return () => clearTimeout(t);
    }
  }, [location.hash]);

  return (
    <div className="animate-fade-in">
      <HeroSection />
      <TickerSection />
      <HowToSection />
      <FeaturesSection />
      <StaminaDemo />
      <ControlsTabs />
      <StatsSection />
      <CtaSection />
      <Footer />
    </div>
  );
}
