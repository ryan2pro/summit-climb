/**
 * World generation tests — the CRITICAL multiplayer determinism guarantee:
 * every client must build a bit-identical mountain from the same seed,
 * otherwise hold raycasts/positions would diverge between peers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateWorld, MOUNTAIN_H, type World } from '@/game/world';

const SEED = 918273;
const noop = () => {};

let worldA: World;
let worldB: World; // same seed as A — must be identical
let worldC: World; // different seed — must differ
let genMsA = 0;

beforeAll(async () => {
  const t0 = performance.now();
  worldA = await generateWorld(SEED, 'low', noop);
  genMsA = performance.now() - t0;
  worldB = await generateWorld(SEED, 'low', noop);
  worldC = await generateWorld(SEED + 1, 'low', noop);
}, 60000);

describe('world: determinism (same seed → identical mountain)', () => {
  it('produces identical terrain heights at a grid of sample points', () => {
    let checked = 0;
    for (let x = -100; x <= 100; x += 10) {
      for (let z = -100; z <= 100; z += 10) {
        expect(worldA.heightAt(x, z)).toBe(worldB.heightAt(x, z));
        checked++;
      }
    }
    expect(checked).toBe(21 * 21);
  });

  it('produces identical vertex + hold + ledge counts', () => {
    expect(worldA.vertCount).toBe(worldB.vertCount);
    expect(worldA.holds.length).toBe(worldB.holds.length);
    expect(worldA.ledges.length).toBe(worldB.ledges.length);
  });

  it('produces bit-identical hold positions, normals and scales', () => {
    expect(worldA.holds.length).toBeGreaterThan(0);
    for (let i = 0; i < worldA.holds.length; i++) {
      const a = worldA.holds[i];
      const b = worldB.holds[i];
      expect(a.pos.x).toBe(b.pos.x);
      expect(a.pos.y).toBe(b.pos.y);
      expect(a.pos.z).toBe(b.pos.z);
      expect(a.normal.x).toBe(b.normal.x);
      expect(a.normal.y).toBe(b.normal.y);
      expect(a.normal.z).toBe(b.normal.z);
      expect(a.scale).toBe(b.scale);
      expect(a.ledge).toBe(b.ledge);
    }
  });

  it('produces identical ledge checkpoints (position, top, spawn, altitude)', () => {
    expect(worldA.ledges.length).toBeGreaterThan(0);
    for (let i = 0; i < worldA.ledges.length; i++) {
      const a = worldA.ledges[i];
      const b = worldB.ledges[i];
      expect(a.center.x).toBe(b.center.x);
      expect(a.center.y).toBe(b.center.y);
      expect(a.center.z).toBe(b.center.z);
      expect(a.topY).toBe(b.topY);
      expect(a.theta).toBe(b.theta);
      expect(a.spawn.x).toBe(b.spawn.x);
      expect(a.spawn.y).toBe(b.spawn.y);
      expect(a.spawn.z).toBe(b.spawn.z);
      expect(a.altitude).toBe(b.altitude);
      expect(a.holdIndex).toBe(b.holdIndex);
      expect(a.name).toBe(b.name);
    }
  });

  it('places the summit identically', () => {
    expect(worldA.summitPos.x).toBe(worldB.summitPos.x);
    expect(worldA.summitPos.y).toBe(worldB.summitPos.y);
    expect(worldA.summitPos.z).toBe(worldB.summitPos.z);
  });
});

describe('world: different seeds → different layout', () => {
  it('produces a different hold layout for a different seed', () => {
    // count may coincide; the actual geometry must not
    const n = Math.min(worldA.holds.length, worldC.holds.length);
    let identical = 0;
    for (let i = 0; i < n; i++) {
      if (worldA.holds[i].pos.equals(worldC.holds[i].pos)) identical++;
    }
    expect(identical).toBeLessThan(n * 0.05);
  });

  it('produces different terrain for a different seed', () => {
    let same = 0;
    let total = 0;
    for (let x = -90; x <= 90; x += 15) {
      for (let z = -90; z <= 90; z += 15) {
        if (worldA.heightAt(x, z) === worldC.heightAt(x, z)) same++;
        total++;
      }
    }
    expect(same).toBeLessThan(total * 0.2);
  });
});

describe('world: route climbability invariants', () => {
  it('keeps consecutive hold gaps ≤ ~3.8m so the route is always climbable', () => {
    let maxGap = 0;
    for (const w of [worldA, worldC]) {
      for (let i = 1; i < w.holds.length; i++) {
        const gap = w.holds[i].pos.distanceTo(w.holds[i - 1].pos);
        maxGap = Math.max(maxGap, gap);
        expect(gap).toBeLessThanOrEqual(3.8);
      }
    }
    // sanity: the route is real climbing, not a ladder of 1cm steps
    expect(maxGap).toBeGreaterThan(1.5);
  });

  it('holds the 3.8m gap cap across several seeds (validates the 8-retry shrink fix)', async () => {
    // fix #1: the route generator used to accept a >3.7m hop when its 3
    // shrink retries ran out. Sweep a spread of seeds — including 918273 —
    // and require every consecutive hop to stay climbable.
    for (const seed of [918273, 918274, 31337, 777, 20260718, 4000000000]) {
      const w = await generateWorld(seed, 'low', noop);
      let maxGap = 0;
      for (let i = 1; i < w.holds.length; i++) {
        maxGap = Math.max(maxGap, w.holds[i].pos.distanceTo(w.holds[i - 1].pos));
      }
      expect(maxGap).toBeLessThanOrEqual(3.8);
    }
  }, 30000);

  it('spaces rest-ledge checkpoints every 8–12 holds after base camp', () => {
    expect(worldA.ledges[0].holdIndex).toBe(0); // 大本营 at route start
    for (let i = 1; i < worldA.ledges.length; i++) {
      const spacing = worldA.ledges[i].holdIndex - worldA.ledges[i - 1].holdIndex;
      expect(spacing).toBeGreaterThanOrEqual(8);
      expect(spacing).toBeLessThanOrEqual(12);
    }
  });

  it('climbs from near the base to just under the summit', () => {
    const first = worldA.holds[0];
    const last = worldA.holds[worldA.holds.length - 1];
    expect(first.pos.y).toBeLessThan(15);
    expect(last.pos.y).toBeGreaterThan(MOUNTAIN_H - 10);
  });
});

describe('world: summit plateau', () => {
  it('has a flat, exactly-150m walkable plateau near the peak', () => {
    for (const [x, z] of [
      [0, 0],
      [2, 2],
      [-3, 1],
      [1, -4],
      [4.5, 0],
    ]) {
      expect(worldA.heightAt(x, z)).toBe(MOUNTAIN_H);
    }
  });

  it('is walkable (gentle slope) at the summit center', () => {
    expect(worldA.slopeAt(0, 0)).toBeLessThan(0.1);
    expect(worldA.slopeAt(2, -2)).toBeLessThan(0.1);
  });

  it('marks the summit at plateau center', () => {
    expect(worldA.summitPos.x).toBe(0);
    expect(worldA.summitPos.z).toBe(0);
    expect(worldA.summitPos.y).toBe(MOUNTAIN_H);
  });
});

describe('world: generation invariants + performance', () => {
  it('logs/derives sane counts: verts > 0, holds > 40', () => {
    expect(worldA.vertCount).toBeGreaterThan(0);
    expect(worldA.holds.length).toBeGreaterThan(40);
    expect(worldA.ledges.length).toBeGreaterThanOrEqual(5);
  });

  it('generates in a reasonable time (<5s in node)', () => {
    expect(genMsA).toBeLessThan(5000);
  });

  it('every hold sits on the terrain surface (never buried, never floating)', () => {
    // holds are placed 0.12m along the surface normal from the sampled point;
    // on steep terraced bands the analytic ground at the offset xz can step
    // by up to ~1.1m, so the window is asymmetric
    for (const h of worldA.holds) {
      const ground = worldA.heightAt(h.pos.x, h.pos.z);
      expect(h.pos.y - ground).toBeGreaterThan(-0.25);
      expect(h.pos.y - ground).toBeLessThan(1.35);
    }
  });

  it('grabRaycast finds a hold aimed at from outside the wall', () => {
    const h = worldA.holds[10];
    const origin = h.pos.clone().addScaledVector(h.normal, 1.5);
    const dir = h.pos.clone().sub(origin).normalize();
    const hit = worldA.grabRaycast(origin, dir, 2.4);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('hold');
    expect(hit!.index).toBe(h.index);
  });

  it('grabRaycast misses when nothing is in range', () => {
    // high above the summit aiming at the sky
    const hit = worldA.grabRaycast(new THREE.Vector3(0, MOUNTAIN_H + 30, 0), new THREE.Vector3(0, 1, 0), 2.4);
    expect(hit).toBeNull();
  });
});
