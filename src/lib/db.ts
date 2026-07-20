/**
 * Persistence layer — hand-rolled promise wrapper over IndexedDB (design.md §11.6).
 *
 * Database `summit-game` v1:
 *   store `kv`      (keyPath 'key')                    — profile, settings
 *   store `records` (keyPath 'id' autoIncrement,
 *                    indexes by_date, by_time)         — run records, capped at 50 newest
 *
 * Fail-soft: when IndexedDB is unavailable (private mode etc.) every function
 * falls back to an in-memory store and keeps working for the session.
 */

export interface PlayerStats {
  summits: number;
  attempts: number;
  bestTimeMs: number | null;
  maxAltitudeM: number;
  totalClimbM: number;
}

export interface Profile {
  key: 'profile';
  name: string;
  color: string;
  cosmetic: string;
  unlocked: string[];
  stats: PlayerStats;
}

export type QualityLevel = 'auto' | 'low' | 'medium' | 'high';

export interface Settings {
  key: 'settings';
  sensitivity: number;
  invertY: boolean;
  gyroEnabled: boolean;
  quality: QualityLevel;
  volume: number;
  reducedMotion: boolean;
}

export interface RunRecord {
  id?: number;
  seed: number;
  date: string; // ISO
  timeMs: number | null;
  summited: boolean;
  peakAltitude: number;
  players: number;
}

export type KvRecord = Profile | Settings;

const DB_NAME = 'summit-game';
const DB_VERSION = 1;
const MAX_RECORDS = 50;

/** Colorblind-aware avatar palette (design.md §2.1). */
export const PLAYER_COLORS = [
  '#D0713F',
  '#E8A94C',
  '#7FA07A',
  '#5E8FB9',
  '#A97FB8',
  '#C85F6E',
  '#8B7D5A',
  '#4FA3A0',
] as const;

export const COSMETICS = ['beanie', 'bandana', 'goggles', 'carabiner', 'champion'] as const;

export function defaultProfile(): Profile {
  return {
    key: 'profile',
    name: '登山者',
    color: PLAYER_COLORS[0],
    cosmetic: 'beanie',
    unlocked: ['beanie'],
    stats: { summits: 0, attempts: 0, bestTimeMs: null, maxAltitudeM: 0, totalClimbM: 0 },
  };
}

export function defaultSettings(): Settings {
  return {
    key: 'settings',
    sensitivity: 1.0,
    invertY: false,
    gyroEnabled: false,
    quality: 'auto',
    volume: 0.8,
    reducedMotion: false,
  };
}

/* ------------------------------------------------------------------ */
/* Low-level open + request helpers                                    */
/* ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase | null> | null = null;
let memoryMode = false;
let onFallback: (() => void) | null = null;

/** Register a one-time callback fired if we degrade to in-memory mode. */
export function onDbFallback(cb: () => void): void {
  onFallback = cb;
}

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      enterMemoryMode();
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      enterMemoryMode();
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_date', 'date', { unique: false });
        store.createIndex('by_time', 'timeMs', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      enterMemoryMode();
      resolve(null);
    };
    req.onblocked = () => {
      enterMemoryMode();
      resolve(null);
    };
  });
  return dbPromise;
}

function enterMemoryMode(): void {
  if (!memoryMode) {
    memoryMode = true;
    console.warn('[db] IndexedDB unavailable — using in-memory fallback');
    try {
      onFallback?.();
    } catch {
      /* noop */
    }
  }
}

export function isMemoryFallback(): boolean {
  return memoryMode;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function store(name: 'kv' | 'records', mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
  const db = await openDB();
  if (!db) return null;
  return db.transaction(name, mode).objectStore(name);
}

/* ------------------------------------------------------------------ */
/* In-memory fallback store                                            */
/* ------------------------------------------------------------------ */

const mem = {
  kv: new Map<string, KvRecord>(),
  records: [] as RunRecord[],
  nextId: 1,
};

/* ------------------------------------------------------------------ */
/* Generic ops (exported for flexibility)                              */
/* ------------------------------------------------------------------ */

export async function dbGet<K extends KvRecord>(key: K['key']): Promise<K | null> {
  const s = await store('kv', 'readonly');
  if (!s) return (mem.kv.get(key) as K | undefined) ?? null;
  try {
    const v = await reqToPromise(s.get(key));
    return (v as K | undefined) ?? null;
  } catch {
    return (mem.kv.get(key) as K | undefined) ?? null;
  }
}

export async function dbSet(value: KvRecord): Promise<void> {
  mem.kv.set(value.key, value);
  const s = await store('kv', 'readwrite');
  if (!s) return;
  try {
    await reqToPromise(s.put(value));
  } catch {
    /* memory copy already updated */
  }
}

export async function dbAdd(record: RunRecord): Promise<number> {
  const s = await store('records', 'readwrite');
  if (!s) {
    const id = mem.nextId++;
    mem.records.push({ ...record, id });
    return id;
  }
  try {
    const key = await reqToPromise(s.add(record));
    return Number(key);
  } catch {
    const id = mem.nextId++;
    mem.records.push({ ...record, id });
    return id;
  }
}

export async function dbAllRecords(): Promise<RunRecord[]> {
  const s = await store('records', 'readonly');
  if (!s) return [...mem.records];
  try {
    const all = await reqToPromise(s.getAll());
    return all as RunRecord[];
  } catch {
    return [...mem.records];
  }
}

export async function dbDeleteRecord(id: number): Promise<void> {
  mem.records = mem.records.filter((r) => r.id !== id);
  const s = await store('records', 'readwrite');
  if (!s) return;
  try {
    await reqToPromise(s.delete(id));
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ */
/* Domain API (design.md §11.6 read/write surfaces)                    */
/* ------------------------------------------------------------------ */

export async function getProfile(): Promise<Profile> {
  const p = await dbGet<Profile>('profile');
  if (!p) return defaultProfile();
  // merge to stay forward-compatible with new stat fields
  const d = defaultProfile();
  return { ...d, ...p, stats: { ...d.stats, ...p.stats } };
}

export async function saveProfile(p: Profile): Promise<void> {
  await dbSet(p);
}

export async function getSettings(): Promise<Settings> {
  const s = await dbGet<Settings>('settings');
  return s ? { ...defaultSettings(), ...s } : defaultSettings();
}

export async function saveSettings(s: Settings): Promise<void> {
  await dbSet(s);
}

/** Add a run record and prune the store to the newest MAX_RECORDS entries. */
export async function addRecord(record: RunRecord): Promise<number> {
  const id = await dbAdd(record);
  await pruneRecords();
  return id;
}

/** Newest-first records, limited (default 8 — lobby 最近战绩 list). */
export async function getRecords(limit = 8): Promise<RunRecord[]> {
  const all = await dbAllRecords();
  return all
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit);
}

/** Best summited time for a given seed (game loading screen 历史最佳). */
export async function getBestForSeed(seed: number): Promise<RunRecord | null> {
  const all = await dbAllRecords();
  const best = all
    .filter((r) => r.seed === seed && r.summited && r.timeMs != null)
    .sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));
  return best[0] ?? null;
}

/** Keep only the newest MAX_RECORDS records. */
export async function pruneRecords(max = MAX_RECORDS): Promise<void> {
  const all = await dbAllRecords();
  if (all.length <= max) return;
  const sorted = all.sort((a, b) => (a.date < b.date ? 1 : -1));
  const stale = sorted.slice(max);
  await Promise.all(stale.map((r) => (r.id != null ? dbDeleteRecord(r.id) : Promise.resolve())));
}
