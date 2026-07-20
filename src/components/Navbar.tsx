import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { scrollToSection } from '@/lib/scroll';
import Button from '@/components/Button';

/**
 * Landing navbar (home.md §0): fixed top, 64px, paper/85 + blur, dashed
 * bottom border (trail motif). Mobile: hamburger → full-screen ink overlay
 * with staggered links.
 */

const LINKS = [
  { id: 'howto', label: '玩法' },
  { id: 'features', label: '特色' },
  { id: 'controls', label: '操作' },
] as const;

function NavLink({ id, label, onClick }: { id: string; label: string; onClick?: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <a
      href={`/#${id}`}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
        if (location.pathname === '/') {
          scrollToSection(id);
        } else {
          navigate(`/#${id}`);
        }
      }}
      className="group relative px-1 py-2 text-[0.95rem] font-medium text-ink transition-colors hover:text-terracotta"
    >
      {label}
      <span className="absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 rounded-full bg-terracotta transition-transform duration-200 ease-smooth group-hover:scale-x-100" />
    </a>
  );
}

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // lock body scroll while the mobile overlay is open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <>
      <motion.header
        initial={{ y: '-100%' }}
        animate={{ y: 0 }}
        transition={{ duration: 0.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          'fixed inset-x-0 top-0 z-50 h-16 border-b-2 border-dashed border-line bg-paper/85 backdrop-blur-[12px] transition-shadow duration-300',
          scrolled && 'shadow-nav',
        )}
      >
        <div className="mx-auto flex h-full max-w-content items-center justify-between px-4 sm:px-6">
          {/* brand */}
          <Link to="/" className="flex items-center gap-2.5" aria-label="攀峰 SUMMIT 首页">
            <img src="/logo.svg" alt="攀峰 logo" className="h-9 w-9" />
            <span className="font-zh text-2xl leading-none text-ink">攀峰</span>
            <span className="mt-1 hidden font-latin text-xs font-semibold tracking-[0.06em] text-terracotta sm:inline">
              SUMMIT
            </span>
          </Link>

          {/* center links (desktop) */}
          <nav className="hidden items-center gap-8 md:flex" aria-label="页面导航">
            {LINKS.map((l) => (
              <NavLink key={l.id} id={l.id} label={l.label} />
            ))}
          </nav>

          {/* CTA + hamburger */}
          <div className="flex items-center gap-3">
            <Button to="/lobby" size="sm" className="hidden h-11 md:inline-flex">
              开始游戏
            </Button>
            <button
              type="button"
              aria-label={open ? '关闭菜单' : '打开菜单'}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="btn-hard-sm flex h-11 w-11 items-center justify-center rounded-full border-2 border-ink bg-paper-deep md:hidden"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                {open ? (
                  <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                ) : (
                  <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </motion.header>

      {/* mobile full-screen overlay menu */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 flex flex-col bg-ink px-8 pb-10 pt-24 md:hidden"
          >
            <nav className="flex flex-col gap-2" aria-label="移动端导航">
              {LINKS.map((l, i) => (
                <motion.div
                  key={l.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.08 + i * 0.06, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setTimeout(() => scrollToSection(l.id), 60);
                    }}
                    className="w-full border-b border-dashed border-snow/15 py-4 text-left font-zh text-3xl text-snow"
                  >
                    {l.label}
                  </button>
                </motion.div>
              ))}
            </nav>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + LINKS.length * 0.06, duration: 0.35 }}
              className="mt-auto"
            >
              <Button to="/lobby" size="lg" className="w-full" onClick={() => setOpen(false)}>
                开始游戏
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
