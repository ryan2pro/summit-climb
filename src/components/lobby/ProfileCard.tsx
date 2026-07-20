import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Lock } from 'lucide-react';
import Card from '@/components/Card';
import { useToast } from '@/components/Toast';
import ClimberPreview from '@/components/lobby/ClimberPreview';
import { useSession } from '@/lib/session';
import { COSMETICS, PLAYER_COLORS } from '@/lib/db';
import type { Profile } from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * Profile card 我的名片 (lobby.md): name editing, avatar color picker
 * (8 colorblind-aware colors, design.md §2.1), cosmetic picker with locked
 * items + unlock conditions, live 3D climber preview.
 *
 * Every change debounce-writes (300ms) to kv.profile via session
 * updateProfile; a subtle 已保存 toast fires on the first change per session.
 */

type ProfilePatch = Partial<Omit<Profile, 'key' | 'stats'>>;

const COSMETIC_META: Record<(typeof COSMETICS)[number], { label: string; unlock: string | null }> = {
  beanie: { label: '毛线帽', unlock: null },
  bandana: { label: '头巾', unlock: '登顶 1 次解锁' },
  goggles: { label: '雪镜', unlock: '登顶 3 次解锁' },
  carabiner: { label: '金色快挂', unlock: '登顶 5 次解锁' },
  champion: { label: '冠军旗纹', unlock: '最佳成绩 8 分钟内解锁' },
};

/** Unlock conditions mirrored from design.md §11.7 (display fallback). */
function deriveUnlocked(profile: Profile): Set<string> {
  const set = new Set<string>(profile.unlocked);
  set.add('beanie');
  const { summits, bestTimeMs } = profile.stats;
  if (summits >= 1) set.add('bandana');
  if (summits >= 3) set.add('goggles');
  if (summits >= 5) set.add('carabiner');
  if (bestTimeMs != null && bestTimeMs < 8 * 60 * 1000) set.add('champion');
  return set;
}

export default function ProfileCard({ pulseKey }: { pulseKey: number }) {
  const { profile, updateProfile } = useSession();
  const toast = useToast();

  // local instant-preview state; session profile is the persisted source
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState(profile.color);
  const [cosmetic, setCosmetic] = useState(profile.cosmetic);

  const patchRef = useRef<ProfilePatch>({});
  const timerRef = useRef<number | null>(null);
  const savedOnceRef = useRef(false);
  // sentinel: last name this card pushed to the session (avoids echoing our
  // own debounced writes back into the input while the user keeps typing)
  const [lastSentName, setLastSentName] = useState<string | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const patch = patchRef.current;
    patchRef.current = {};
    if (Object.keys(patch).length === 0) return;
    if (patch.name != null) setLastSentName(patch.name);
    void updateProfile(patch);
    if (!savedOnceRef.current) {
      savedOnceRef.current = true;
      toast('已保存');
    }
  }, [updateProfile, toast]);

  const scheduleSave = useCallback(
    (patch: ProfilePatch) => {
      patchRef.current = { ...patchRef.current, ...patch };
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, 300);
    },
    [flush],
  );

  // flush pending writes on unmount
  useEffect(() => flush, [flush]);

  // adopt external profile changes (first-visit random name, db load) —
  // "adjust state during render" pattern instead of setState-in-effect
  const [prevProfile, setPrevProfile] = useState({
    name: profile.name,
    color: profile.color,
    cosmetic: profile.cosmetic,
  });
  if (
    profile.name !== prevProfile.name ||
    profile.color !== prevProfile.color ||
    profile.cosmetic !== prevProfile.cosmetic
  ) {
    setPrevProfile({ name: profile.name, color: profile.color, cosmetic: profile.cosmetic });
    if (profile.name !== lastSentName) setName(profile.name);
    setLastSentName(null);
    setColor(profile.color);
    setCosmetic(profile.cosmetic);
  }

  // name-setup pulse (route guard / first arrival without a name): a 2s amber
  // ring rendered as a keyed overlay so each pulse re-triggers once
  const [pulseDoneKey, setPulseDoneKey] = useState(0);
  const pulseActive = pulseKey > 0 && pulseKey !== pulseDoneKey;

  const unlocked = deriveUnlocked(profile);

  return (
    <Card radius="lg" className="p-6">
      <div className="flex items-end justify-between">
        <h3 className="font-zh text-2xl text-ink">我的名片</h3>
        <span className="font-latin text-xs font-semibold uppercase tracking-[0.3em] text-terracotta">
          Climber
        </span>
      </div>

      {/* live 3D preview */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 22 }}
        className="relative mt-4 rounded-2xl border-2 border-line/70 bg-snow/50"
      >
        <ClimberPreview color={color} cosmetic={cosmetic} />
        <span className="pointer-events-none absolute bottom-2 right-3 text-[0.65rem] font-bold text-ink-soft/60">
          拖动旋转
        </span>
      </motion.div>

      {/* 昵称 */}
      <label className="mt-5 block text-sm font-bold text-ink-soft" htmlFor="profile-name">
        昵称
      </label>
      <div className="relative mt-1.5">
        {pulseActive && (
          <motion.span
            key={pulseKey}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl"
            initial={{ boxShadow: '0 0 0 0px rgba(232,169,76,0)' }}
            animate={{
              boxShadow: [
                '0 0 0 0px rgba(232,169,76,0)',
                '0 0 0 5px rgba(232,169,76,0.65)',
                '0 0 0 3px rgba(232,169,76,0.45)',
                '0 0 0 0px rgba(232,169,76,0)',
              ],
            }}
            transition={{ duration: 2, ease: 'easeInOut' }}
            onAnimationComplete={() => setPulseDoneKey(pulseKey)}
          />
        )}
        <input
          id="profile-name"
          type="text"
          value={name}
          maxLength={8}
          placeholder="爬山的人"
          onChange={(e) => {
            setName(e.target.value);
            scheduleSave({ name: e.target.value });
          }}
          className={cn(
            'h-12 w-full rounded-xl border-2 border-line bg-snow/70 px-4 font-bold text-ink placeholder:font-medium placeholder:text-ink-soft/50',
            'transition-shadow focus:border-terracotta focus:outline-none focus:ring-4 focus:ring-terracotta/25',
            pulseActive && 'border-amber',
          )}
        />
      </div>

      {/* 颜色 */}
      <div className="mt-5 text-sm font-bold text-ink-soft">颜色</div>
      <div className="mt-2 flex flex-wrap gap-2.5">
        {PLAYER_COLORS.map((c) => {
          const active = c === color;
          return (
            <motion.button
              key={c}
              type="button"
              aria-label={`选择颜色 ${c}`}
              aria-pressed={active}
              onClick={() => {
                setColor(c);
                scheduleSave({ color: c });
              }}
              whileTap={{ scale: 0.9 }}
              animate={{ scale: active ? 1.12 : 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 20 }}
              className={cn(
                'h-10 w-10 rounded-full border-2 border-ink/60',
                active && 'ring-[2.5px] ring-ink ring-offset-2 ring-offset-paper-deep',
              )}
              style={{ backgroundColor: c }}
            />
          );
        })}
      </div>

      {/* 装扮 */}
      <div className="mt-5 text-sm font-bold text-ink-soft">装扮</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {COSMETICS.map((id, i) => {
          const meta = COSMETIC_META[id];
          const isUnlocked = unlocked.has(id);
          const active = id === cosmetic;
          return (
            <motion.button
              key={id}
              type="button"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.05 + i * 0.04, type: 'spring', stiffness: 400, damping: 26 }}
              disabled={!isUnlocked}
              title={isUnlocked ? meta.label : `${meta.label} · ${meta.unlock ?? ''}`}
              aria-pressed={active}
              onClick={() => {
                setCosmetic(id);
                scheduleSave({ cosmetic: id });
              }}
              className={cn(
                'btn-hard-sm inline-flex h-9 items-center gap-1.5 rounded-full border-2 px-3.5 text-sm font-bold',
                active
                  ? 'border-ink bg-terracotta text-snow'
                  : 'border-ink/25 bg-snow/70 text-ink hover:border-ink/60',
                !isUnlocked && 'cursor-not-allowed opacity-50',
              )}
            >
              {!isUnlocked && <Lock size={13} aria-hidden />}
              {meta.label}
            </motion.button>
          );
        })}
      </div>
    </Card>
  );
}
