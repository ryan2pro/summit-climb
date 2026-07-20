/**
 * Seeded PRNG helpers (design.md §11.1).
 *
 * World generation consumes a single PRNG chain in a fixed order so every
 * client builds a bit-identical mountain from the same seed. `Math.random`
 * and `Date.now` are forbidden inside generation — always draw from a chain
 * created here.
 */

/** xmur3 string hash → 32-bit seed factory. Call the returned fn once to get a seed. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** mulberry32 — tiny fast seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Create a PRNG chain from a numeric or string seed. */
export function rngFromSeed(seed: number | string): () => number {
  const s = typeof seed === 'string' ? xmur3(seed)() : seed >>> 0;
  return mulberry32(s);
}

/** rand float in [min, max) */
export function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** rand int in [min, max] inclusive */
export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(randRange(rng, min, max + 1));
}

/** pick one element deterministically */
export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** A fresh random 32-bit world seed (used by the host at room start). */
export function newWorldSeed(): number {
  return (Math.random() * 2 ** 32) >>> 0;
}

/** Format a seed as the 6-digit 种子 # shown in UI. */
export function formatSeed(seed: number): string {
  return String(seed % 1000000).padStart(6, '0');
}
