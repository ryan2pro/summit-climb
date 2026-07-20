/**
 * Session context (design.md §11.8) — carries the run configuration between
 * the lobby and the game pages:
 *
 *   { mode: 'solo' | 'host' | 'join', seed, profile, room?: RoomSession }
 *
 * `/game` route guard: entering without a mode/seed context should redirect
 * back to `/lobby` (use `hasRunContext`).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Profile, RunRecord } from '@/lib/db';
import {
  addRecord,
  defaultProfile,
  getProfile,
  getRecords,
  saveProfile,
  getBestForSeed,
} from '@/lib/db';
import { newWorldSeed } from '@/lib/prng';
import type { RoomSession } from '@/lib/net';

export type SessionMode = 'solo' | 'host' | 'join';

export interface SessionState {
  mode: SessionMode;
  seed: number;
  profile: Profile;
  room: RoomSession | null;
  profileLoaded: boolean;
}

export interface SessionApi extends SessionState {
  /** Configure a solo run (random seed unless provided). */
  startSolo: (seed?: number) => void;
  /** Configure as room host with the given seed + live session. */
  startHost: (seed: number, room: RoomSession) => void;
  /** Configure as room joiner (seed arrives via the `start` message). */
  startJoin: (seed: number, room: RoomSession) => void;
  /** Update + persist the player profile (name/color/cosmetic). */
  updateProfile: (patch: Partial<Omit<Profile, 'key' | 'stats'>>) => Promise<void>;
  /** Persist stats after a run ends. */
  recordRun: (rec: Omit<RunRecord, 'id'>) => Promise<void>;
  /** Recent records for lobby lists. */
  recentRecords: (limit?: number) => Promise<RunRecord[]>;
  /** Best summited time for a seed (game loading screen). */
  bestForSeed: (seed: number) => Promise<RunRecord | null>;
  /** Clear run context (back to lobby / leave room). */
  reset: () => void;
  hasRunContext: boolean;
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<SessionMode>('solo');
  const [seed, setSeed] = useState<number>(() => newWorldSeed());
  const [room, setRoom] = useState<RoomSession | null>(null);
  const [profile, setProfile] = useState<Profile>(() => defaultProfile());
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const roomRef = useRef<RoomSession | null>(null);
  // initial getProfile() promise — updateProfile/recordRun await it so a
  // write issued while the load is in flight lands *after* it and can no
  // longer be clobbered when the load resolves (race fix)
  const loadRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    let alive = true;
    const load = getProfile()
      .then((p) => {
        if (alive) setProfile(p);
      })
      .catch(() => {
        /* keep defaults when the read fails */
      })
      .finally(() => {
        if (alive) setProfileLoaded(true);
      });
    loadRef.current = load;
    return () => {
      alive = false;
    };
  }, []);

  // close room on unmount of the provider (page unload)
  useEffect(() => {
    return () => {
      roomRef.current?.close();
    };
  }, []);

  const startSolo = useCallback((s?: number) => {
    roomRef.current?.close();
    setRoom(null);
    setMode('solo');
    setSeed(s ?? newWorldSeed());
    setHasRun(true);
  }, []);

  const startHost = useCallback((s: number, r: RoomSession) => {
    roomRef.current?.close();
    setRoom(r);
    setMode('host');
    setSeed(s);
    setHasRun(true);
  }, []);

  const startJoin = useCallback((s: number, r: RoomSession) => {
    setRoom(r);
    setMode('join');
    setSeed(s);
    setHasRun(true);
  }, []);

  const updateProfile = useCallback(async (patch: Partial<Omit<Profile, 'key' | 'stats'>>) => {
    // queue behind the initial load (see loadRef) so the patch is applied
    // on top of the persisted profile, not overwritten by it
    await loadRef.current;
    setProfile((prev) => {
      const next = { ...prev, ...patch, key: 'profile' as const };
      void saveProfile(next);
      return next;
    });
  }, []);

  const recordRun = useCallback(async (rec: Omit<RunRecord, 'id'>) => {
    await loadRef.current; // same load-race guard as updateProfile
    await addRecord(rec);
    setProfile((prev) => {
      const stats = { ...prev.stats };
      stats.attempts += 1;
      if (rec.summited) {
        stats.summits += 1;
        if (rec.timeMs != null && (stats.bestTimeMs == null || rec.timeMs < stats.bestTimeMs)) {
          stats.bestTimeMs = rec.timeMs;
        }
      }
      stats.maxAltitudeM = Math.max(stats.maxAltitudeM, rec.peakAltitude);
      stats.totalClimbM += Math.max(0, rec.peakAltitude);
      const next = { ...prev, stats };
      void saveProfile(next);
      return next;
    });
  }, []);

  const recentRecords = useCallback((limit = 8) => getRecords(limit), []);
  const bestForSeed = useCallback((s: number) => getBestForSeed(s), []);

  const reset = useCallback(() => {
    roomRef.current?.leave();
    setRoom(null);
    setHasRun(false);
  }, []);

  const api = useMemo<SessionApi>(
    () => ({
      mode,
      seed,
      profile,
      room,
      profileLoaded,
      startSolo,
      startHost,
      startJoin,
      updateProfile,
      recordRun,
      recentRecords,
      bestForSeed,
      reset,
      hasRunContext: hasRun,
    }),
    [mode, seed, profile, room, profileLoaded, startSolo, startHost, startJoin, updateProfile, recordRun, recentRecords, bestForSeed, reset, hasRun],
  );

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook co-located with its provider
export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
