/**
 * Session context tests — SessionProvider + useSession against fake-indexeddb.
 * Kept light: no router, no game loop; just the run-config state machine and
 * its persistence side effects.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { SessionProvider, useSession, type SessionApi } from '@/lib/session';
import { defaultProfile, getProfile, getRecords, saveProfile } from '@/lib/db';

let api!: SessionApi;

function Probe(): null {
  // eslint-disable-next-line react-hooks/globals -- test probe: capture the context for assertions
  api = useSession();
  return null;
}

async function renderSession(): Promise<void> {
  await act(async () => {
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
  });
}

/** Render and wait until the persisted profile has loaded (like the lobby UI does). */
async function renderReady(): Promise<void> {
  await renderSession();
  await waitFor(() => expect(api.profileLoaded).toBe(true));
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('session: run configuration', () => {
  it('startSolo sets mode + seed and marks a run context', async () => {
    await renderSession();
    act(() => api.startSolo(123456));
    expect(api.mode).toBe('solo');
    expect(api.seed).toBe(123456);
    expect(api.hasRunContext).toBe(true);
    expect(api.room).toBeNull();
  });

  it('startSolo without a seed rolls a fresh uint32 world seed', async () => {
    await renderSession();
    act(() => api.startSolo());
    expect(api.seed).toBeGreaterThanOrEqual(0);
    expect(api.seed).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(api.seed)).toBe(true);
    expect(api.hasRunContext).toBe(true);
  });

  it('reset clears the run context (back to lobby)', async () => {
    await renderSession();
    act(() => api.startSolo(777));
    expect(api.hasRunContext).toBe(true);
    act(() => api.reset());
    expect(api.hasRunContext).toBe(false);
    expect(api.room).toBeNull();
  });

  it('loads a persisted profile on mount', async () => {
    const p = defaultProfile();
    p.name = '预存玩家';
    await saveProfile(p);
    await renderSession();
    await waitFor(() => expect(api.profileLoaded).toBe(true));
    expect(api.profile.name).toBe('预存玩家');
  });
});

describe('session: profile + records persistence', () => {
  it('updateProfile patches state and persists to IndexedDB', async () => {
    await renderReady();
    await act(async () => {
      await api.updateProfile({ name: '新名字', color: '#7FA07A', cosmetic: 'bandana' });
    });
    expect(api.profile.name).toBe('新名字');
    await act(tick); // saveProfile is fire-and-forget inside setProfile
    const stored = await getProfile();
    expect(stored.name).toBe('新名字');
    expect(stored.color).toBe('#7FA07A');
    expect(stored.cosmetic).toBe('bandana');
  });

  it('recordRun writes a run record and updates profile stats', async () => {
    await renderReady();
    const base = { ...api.profile.stats };
    await act(async () => {
      await api.recordRun({
        seed: 4242,
        date: new Date(2026, 5, 1, 12).toISOString(),
        timeMs: 90000,
        summited: true,
        peakAltitude: 150,
        players: 1,
      });
    });
    // record is queryable through the session api
    const recs = await api.recentRecords(10);
    expect(recs.some((r) => r.seed === 4242 && r.timeMs === 90000 && r.summited)).toBe(true);
    const best = await api.bestForSeed(4242);
    expect(best).not.toBeNull();
    expect(best!.timeMs).toBe(90000);
    // stats updated (relative to whatever previous tests persisted)
    expect(api.profile.stats.attempts).toBe(base.attempts + 1);
    expect(api.profile.stats.summits).toBe(base.summits + 1);
    expect(api.profile.stats.bestTimeMs).toBe(Math.min(base.bestTimeMs ?? Infinity, 90000));
    expect(api.profile.stats.maxAltitudeM).toBe(Math.max(base.maxAltitudeM, 150));
    expect(api.profile.stats.totalClimbM).toBe(base.totalClimbM + 150);
    // and persisted
    await act(tick);
    const stored = await getProfile();
    expect(stored.stats.attempts).toBe(base.attempts + 1);
    // raw records list agrees
    expect((await getRecords(10)).some((r) => r.seed === 4242)).toBe(true);
  });

  it('recordRun without summit increments attempts only; best time tracks the fastest summit', async () => {
    await renderReady();
    const base = { ...api.profile.stats };
    const bestAfter120 = Math.min(base.bestTimeMs ?? Infinity, 120000);
    await act(async () => {
      await api.recordRun({
        seed: 1,
        date: new Date(2026, 5, 2).toISOString(),
        timeMs: 120000,
        summited: true,
        peakAltitude: 150,
        players: 2,
      });
    });
    await act(async () => {
      await api.recordRun({
        seed: 1,
        date: new Date(2026, 5, 3).toISOString(),
        timeMs: null,
        summited: false,
        peakAltitude: 60,
        players: 2,
      });
    });
    expect(api.profile.stats.attempts).toBe(base.attempts + 2);
    expect(api.profile.stats.summits).toBe(base.summits + 1); // failed run adds no summit
    expect(api.profile.stats.bestTimeMs).toBe(bestAfter120);
    // a faster summit lowers the best
    await act(async () => {
      await api.recordRun({
        seed: 1,
        date: new Date(2026, 5, 4).toISOString(),
        timeMs: 80000,
        summited: true,
        peakAltitude: 150,
        players: 2,
      });
    });
    expect(api.profile.stats.bestTimeMs).toBe(Math.min(bestAfter120, 80000));
    expect(api.profile.stats.summits).toBe(base.summits + 2);
  });

  it('useSession throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useSession must be used inside/);
    spy.mockRestore();
  });
});
