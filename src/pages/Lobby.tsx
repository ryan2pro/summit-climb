import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Settings as SettingsIcon } from 'lucide-react';
import ProfileCard from '@/components/lobby/ProfileCard';
import RecordsCard from '@/components/lobby/RecordsCard';
import RoomPanel from '@/components/lobby/RoomPanel';
import SettingsDrawer from '@/components/lobby/SettingsDrawer';
import { useToast } from '@/components/Toast';
import { useSession } from '@/lib/session';
import { dbGet } from '@/lib/db';
import type { Profile } from '@/lib/db';

/**
 * Lobby 大厅 (/lobby) — base-camp check-in board (lobby.md):
 * profile card + records on the left, room panel (create / join / solo) on
 * the right, settings drawer. Warm paper + faint topographic map pattern.
 *
 * Route guard: starting any run requires a non-empty profile name — the name
 * input pulses amber and a toast prompts setup (defaults exist so it is
 * never blocking).
 */

// Faint tiled topographic-line pattern (line color at low weight on paper).
const TOPO_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">' +
    '<g fill="none" stroke="#D8C7A8" stroke-width="1.5" stroke-opacity="0.55">' +
    '<path d="M20 90c0-38 32-70 70-70s70 32 70 70-32 70-70 70-70-32-70-70Z"/>' +
    '<path d="M45 90c0-24 21-45 45-45s45 21 45 45-21 45-45 45-45-21-45-45Z"/>' +
    '<path d="M70 90c0-11 9-20 20-20s20 9 20 20-9 20-20 20-20-9-20-20Z"/>' +
    '<path d="M-20 30c30-12 60-12 90 0s60 12 90 0"/>' +
    '<path d="M-20 160c30-12 60-12 90 0s60 12 90 0"/>' +
    '</g></svg>',
);

const springIn = { type: 'spring', stiffness: 300, damping: 26 } as const;

export default function Lobby() {
  const { profile, profileLoaded, updateProfile } = useSession();
  const toast = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [namePulse, setNamePulse] = useState(0);

  // First visit: seed a random default name 山顶路人NN (lobby.md 我的名片).
  // Arriving with a stored-but-empty name: pulse the input once to invite setup.
  useEffect(() => {
    if (!profileLoaded) return;
    let alive = true;
    void dbGet<Profile>('profile').then((stored) => {
      if (!alive) return;
      if (!stored) {
        const suffix = Math.floor(Math.random() * 90) + 10;
        void updateProfile({ name: `山顶路人${suffix}` });
      } else if (!stored.name?.trim()) {
        setNamePulse(Date.now());
      }
    });
    return () => {
      alive = false;
    };
  }, [profileLoaded, updateProfile]);

  /** Route guard: runs may only start with a named profile. */
  const guardName = useCallback((): boolean => {
    if (profile.name.trim()) return true;
    toast('先给自己起个名字吧', 'info');
    setNamePulse(Date.now());
    return false;
  }, [profile.name, toast]);

  return (
    <div className="relative min-h-[calc(100dvh-64px)]">
      {/* topographic map pattern */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `url("data:image/svg+xml,${TOPO_SVG}")`,
          backgroundSize: '180px 180px',
        }}
      />

      <div className="relative mx-auto max-w-[1120px] px-4 pb-16 sm:px-6">
        {/* in-page top bar (not fixed) */}
        <motion.header
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="flex h-16 items-center justify-between"
        >
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm font-bold text-ink-soft transition-colors hover:text-terracotta"
          >
            <ArrowLeft size={16} aria-hidden />
            返回首页
          </Link>
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="攀峰" className="h-8 w-8" />
            <span className="font-zh text-xl text-ink">攀峰</span>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="设置"
            className="rounded-full border-2 border-ink/15 bg-paper-deep p-2 text-ink transition-colors hover:border-ink hover:text-terracotta"
          >
            <SettingsIcon size={18} />
          </button>
        </motion.header>

        {/* main grid: profile+records left / room panel right (mobile: stacked) */}
        <main className="flex flex-col gap-6 py-8 lg:grid lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start">
          <motion.div
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...springIn, delay: 0.1 }}
            className="lg:col-start-1 lg:row-start-1"
          >
            <ProfileCard pulseKey={namePulse} />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...springIn, delay: 0.2 }}
            className="lg:col-start-2 lg:row-start-1 lg:row-span-2"
          >
            <RoomPanel guardName={guardName} />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...springIn, delay: 0.22 }}
            className="lg:col-start-1 lg:row-start-2"
          >
            <RecordsCard />
          </motion.div>
        </main>

        {/* footer strip */}
        <footer className="py-6 text-center">
          <p className="text-sm text-ink-soft">WebRTC 点对点连接 · 房间码不会上传到任何服务器</p>
          <p className="mt-1 font-mono text-xs uppercase tracking-[0.25em] text-ink-soft/60">
            P2P · No Server
          </p>
        </footer>
      </div>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
