/**
 * DB tests — run against fake-indexeddb (fresh factory + fresh module per
 * test, since db.ts caches its connection promise) plus the no-IndexedDB
 * in-memory fallback path.
 */
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { RunRecord, Settings } from '@/lib/db';

type Db = typeof import('@/lib/db');

/** Fresh module + fresh empty IndexedDB (or none) per test. */
async function freshDb(withIdb = true): Promise<Db> {
  vi.resetModules();
  if (withIdb) {
    globalThis.indexedDB = new IDBFactory();
  } else {
    delete (globalThis as Record<string, unknown>).indexedDB;
  }
  return import('@/lib/db');
}

function rec(partial: Partial<RunRecord> & { seed: number }): RunRecord {
  return {
    date: new Date(2026, 0, 1).toISOString(),
    timeMs: 60000,
    summited: true,
    peakAltitude: 150,
    players: 1,
    ...partial,
  };
}

describe('db: profile', () => {
  it('returns defaults when nothing is stored', async () => {
    const db = await freshDb();
    const p = await db.getProfile();
    expect(p).toEqual(db.defaultProfile());
    expect(p.stats).toEqual({ summits: 0, attempts: 0, bestTimeMs: null, maxAltitudeM: 0, totalClimbM: 0 });
  });

  it('saveProfile/getProfile round-trips', async () => {
    const db = await freshDb();
    const p = db.defaultProfile();
    p.name = '测试登山者';
    p.color = '#5E8FB9';
    p.cosmetic = 'goggles';
    p.unlocked = ['beanie', 'goggles'];
    p.stats = { summits: 3, attempts: 7, bestTimeMs: 81234, maxAltitudeM: 150, totalClimbM: 640 };
    await db.saveProfile(p);
    const loaded = await db.getProfile();
    expect(loaded).toEqual(p);
  });

  it('merges missing stat fields with defaults (forward-compatible)', async () => {
    const db = await freshDb();
    const legacy = {
      ...db.defaultProfile(),
      stats: { summits: 2 },
    } as unknown as ReturnType<Db['defaultProfile']>;
    await db.saveProfile(legacy);
    const loaded = await db.getProfile();
    expect(loaded.stats.summits).toBe(2);
    expect(loaded.stats.attempts).toBe(0);
    expect(loaded.stats.bestTimeMs).toBeNull();
    expect(loaded.stats.maxAltitudeM).toBe(0);
  });
});

describe('db: settings', () => {
  it('returns defaults when nothing is stored', async () => {
    const db = await freshDb();
    expect(await db.getSettings()).toEqual(db.defaultSettings());
  });

  it('merges a partial stored settings blob over defaults', async () => {
    const db = await freshDb();
    await db.saveSettings({ key: 'settings', sensitivity: 1.8, invertY: true } as unknown as Settings);
    const s = await db.getSettings();
    expect(s.sensitivity).toBe(1.8);
    expect(s.invertY).toBe(true);
    expect(s.volume).toBe(0.8); // default preserved
    expect(s.quality).toBe('auto');
  });

  it('saveSettings/getSettings round-trips a full blob', async () => {
    const db = await freshDb();
    const s: Settings = {
      key: 'settings',
      sensitivity: 0.6,
      invertY: true,
      gyroEnabled: true,
      quality: 'low',
      volume: 0.35,
      reducedMotion: true,
    };
    await db.saveSettings(s);
    expect(await db.getSettings()).toEqual(s);
  });
});

describe('db: run records', () => {
  it('addRecord returns incrementing ids and getRecords is newest-first with limit', async () => {
    const db = await freshDb();
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await db.addRecord(rec({ seed: 100 + i, date: new Date(2026, 0, 1, 10, i).toISOString() })));
    }
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    const latest = await db.getRecords(8);
    expect(latest).toHaveLength(8);
    expect(latest[0].seed).toBe(109); // newest first
    for (let i = 1; i < latest.length; i++) {
      expect(latest[i - 1].date >= latest[i].date).toBe(true);
    }
    expect((await db.getRecords(3)).map((r) => r.seed)).toEqual([109, 108, 107]);
  });

  it('prunes the store to the 50 newest records', async () => {
    const db = await freshDb();
    for (let i = 0; i < 55; i++) {
      await db.addRecord(rec({ seed: 1000 + i, date: new Date(2026, 0, 2, 8, 0, i).toISOString() }));
    }
    const all = await db.getRecords(100);
    expect(all).toHaveLength(50);
    // the 5 oldest (seeds 1000–1004) are gone; newest survived
    const seeds = all.map((r) => r.seed);
    expect(seeds).toContain(1054);
    expect(seeds).toContain(1005);
    expect(seeds).not.toContain(1004);
    expect(seeds).not.toContain(1000);
  });

  it('getBestForSeed returns the best summited time for that seed only', async () => {
    const db = await freshDb();
    await db.addRecord(rec({ seed: 42, timeMs: 95000, date: '2026-01-01T00:00:00.000Z' }));
    await db.addRecord(rec({ seed: 42, timeMs: 88000, date: '2026-01-02T00:00:00.000Z' }));
    await db.addRecord(rec({ seed: 42, timeMs: 99000, date: '2026-01-03T00:00:00.000Z' }));
    await db.addRecord(rec({ seed: 42, timeMs: null, summited: false, peakAltitude: 40 })); // crashed run
    await db.addRecord(rec({ seed: 42, timeMs: 60000, summited: false, peakAltitude: 90 })); // no summit → not a "best"
    await db.addRecord(rec({ seed: 7, timeMs: 50000, date: '2026-01-04T00:00:00.000Z' })); // other seed
    const best = await db.getBestForSeed(42);
    expect(best).not.toBeNull();
    expect(best!.timeMs).toBe(88000);
    expect(best!.seed).toBe(42);
    expect((await db.getBestForSeed(7))!.timeMs).toBe(50000);
    expect(await db.getBestForSeed(999)).toBeNull();
  });

  it('persists across module reloads (durability)', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const db1 = await import('@/lib/db');
    await db1.saveProfile({ ...db1.defaultProfile(), name: '持久化' });
    await db1.addRecord(rec({ seed: 555 }));
    // simulate a page reload: fresh module, SAME IndexedDB
    vi.resetModules();
    const db2 = await import('@/lib/db');
    expect((await db2.getProfile()).name).toBe('持久化');
    expect((await db2.getRecords(10)).some((r) => r.seed === 555)).toBe(true);
  });
});

describe('db: in-memory fallback (IndexedDB unavailable)', () => {
  it('degrades gracefully and keeps every API working without throwing', async () => {
    const db = await freshDb(false);
    let fellBack = 0;
    db.onDbFallback(() => fellBack++);
    expect(db.isMemoryFallback()).toBe(false);
    // first touch triggers the fallback
    const p0 = await db.getProfile();
    expect(p0).toEqual(db.defaultProfile());
    expect(db.isMemoryFallback()).toBe(true);
    expect(fellBack).toBe(1);

    const p = { ...db.defaultProfile(), name: '内存模式' };
    await db.saveProfile(p);
    expect((await db.getProfile()).name).toBe('内存模式');

    await db.saveSettings({ ...db.defaultSettings(), volume: 0.1 });
    expect((await db.getSettings()).volume).toBe(0.1);

    const id = await db.addRecord(rec({ seed: 77 }));
    expect(id).toBeGreaterThan(0);
    expect((await db.getRecords(5))[0].seed).toBe(77);
    expect((await db.getBestForSeed(77))!.seed).toBe(77);

    // prune works against the memory store too
    for (let i = 0; i < 55; i++) {
      await db.addRecord(rec({ seed: 2000 + i, date: new Date(2026, 1, 1, 0, 0, i).toISOString() }));
    }
    expect(await db.getRecords(100)).toHaveLength(50);
  });
});
