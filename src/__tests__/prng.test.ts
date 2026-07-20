import { describe, expect, it } from 'vitest';
import { formatSeed, mulberry32, newWorldSeed, randInt, randRange, rngFromSeed, xmur3 } from '@/lib/prng';

describe('prng: determinism', () => {
  it('same seed produces an identical sequence', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it('same string seed produces an identical sequence (rngFromSeed)', () => {
    const a = rngFromSeed('summit-world-777');
    const b = rngFromSeed('summit-world-777');
    const seqA = Array.from({ length: 64 }, () => a());
    const seqB = Array.from({ length: 64 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('numeric and string seeding paths are stable across instances', () => {
    expect(rngFromSeed(42)()).toBe(rngFromSeed(42)());
    expect(xmur3('攀峰')()).toBe(xmur3('攀峰')());
  });

  it('different seeds produce different sequences', () => {
    const a = rngFromSeed(1);
    const b = rngFromSeed(2);
    const seqA = Array.from({ length: 16 }, () => a());
    const seqB = Array.from({ length: 16 }, () => b());
    expect(seqA).not.toEqual(seqB);
    // and it's not a single fluke element
    expect(seqA.filter((v, i) => v === seqB[i]).length).toBe(0);
  });
});

describe('prng: output ranges', () => {
  it('mulberry32 returns floats in [0, 1)', () => {
    const rng = mulberry32(999);
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('mulberry32 is not degenerate (roughly uniform over deciles)', () => {
    const rng = mulberry32(2024);
    const buckets = new Array(10).fill(0) as number[];
    for (let i = 0; i < 10000; i++) buckets[Math.floor(rng() * 10)]++;
    for (const b of buckets) {
      // each decile should hold ~1000 ± 30%
      expect(b).toBeGreaterThan(700);
      expect(b).toBeLessThan(1300);
    }
  });

  it('randRange stays within [min, max)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = randRange(rng, -3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
    }
  });

  it('randInt stays within [min, max] inclusive and returns integers', () => {
    const rng = mulberry32(8);
    for (let i = 0; i < 1000; i++) {
      const v = randInt(rng, 8, 12);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThanOrEqual(12);
    }
  });

  it('newWorldSeed returns a uint32', () => {
    for (let i = 0; i < 100; i++) {
      const s = newWorldSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
      expect(s >>> 0).toBe(s);
    }
  });

  it('formatSeed always renders 6 digits', () => {
    expect(formatSeed(0)).toBe('000000');
    expect(formatSeed(42)).toBe('000042');
    expect(formatSeed(999999)).toBe('999999');
    expect(formatSeed(1234567)).toBe('234567'); // wraps mod 1e6
    expect(formatSeed(0xffffffff)).toBe('967295'); // 4294967295 % 1e6
    expect(formatSeed(0xffffffff)).toHaveLength(6);
  });
});
