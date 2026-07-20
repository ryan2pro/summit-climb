/**
 * Player physics — headless fixed-step (120Hz) simulation, exactly how the
 * game loop drives Player.update. No renderer involved.
 *
 * Spec anchors (design.md §11.3): stamina 100 max · hang 2.5/s idle, 6/s
 * moving · wall jump 12 · ground jump 6 · regen 25/s ground, 40/s on rest
 * ledges after a 0.6s delay · empty stamina while hanging → forced release
 * + 1.2s 力竭 grab lockout · fall > 18m → checkpoint rescue.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateWorld, type Hold, type World } from '@/game/world';
import { Player, STAM, type FrameInput, type PlayerEvents } from '@/game/player';

const DT = 1 / 120;
const IDLE: FrameInput = { moveX: 0, moveY: 0, jump: false, grab: false };

function makeEvents() {
  const log: string[] = [];
  const events: PlayerEvents = {
    onGrab: () => log.push('grab'),
    onJump: () => log.push('jump'),
    onWallJump: () => log.push('walljump'),
    onLand: () => log.push('land'),
    onCheckpoint: () => log.push('checkpoint'),
    onSummit: () => log.push('summit'),
    onRespawn: () => log.push('respawn'),
    onExhausted: () => log.push('exhausted'),
    onFallPrompt: () => log.push('fallprompt'),
  };
  return { events, log };
}

class Sim {
  readonly player: Player;
  readonly log: string[];
  now = 0;

  constructor(world: World) {
    const { events, log } = makeEvents();
    this.log = log;
    this.player = new Player(world, events);
  }

  /** Run `seconds` of fixed substeps with a held input snapshot. */
  step(input: Partial<FrameInput> = {}, seconds = DT): void {
    const full: FrameInput = { ...IDLE, ...input };
    const n = Math.max(1, Math.round(seconds / DT));
    for (let i = 0; i < n; i++) {
      this.now += DT;
      this.player.update(DT, full, this.now);
    }
  }
}

/** Place the player hovering in front of a hold, camera aimed at its center. */
function aimAtHold(sim: Sim, hold: Hold, dist = 1.2): void {
  const p = sim.player;
  const eye = hold.pos.clone().addScaledVector(hold.normal, dist);
  p.pos.set(eye.x, eye.y - 1.55, eye.z);
  p.vel.set(0, 0, 0);
  p.state = 'air';
  const d = hold.pos.clone().sub(eye).normalize();
  p.yaw = Math.atan2(-d.x, -d.z);
  p.pitch = Math.asin(d.y);
}

/** Find a walkable natural-ground spot (no ledge platforms nearby). */
function findFlatSpot(w: World): { x: number; z: number } {
  for (let r = 120; r > 25; r -= 4) {
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (w.heightAt(x, z) > 40) continue;
      if (w.slopeAt(x, z) > 0.5) continue;
      let nearLedge = false;
      for (const L of w.ledges) {
        if (Math.hypot(L.center.x - x, L.center.z - z) < 5) {
          nearLedge = true;
          break;
        }
      }
      if (!nearLedge) return { x, z };
    }
  }
  throw new Error('no flat spot found');
}

let world: World;

beforeAll(async () => {
  world = await generateWorld(31337, 'low', () => {});
}, 60000);

describe('player: gravity + ground', () => {
  it('falls under gravity and comes to rest exactly on the ground', () => {
    const sim = new Sim(world);
    const spot = findFlatSpot(world);
    sim.player.pos.set(spot.x, world.heightAt(spot.x, spot.z) + 5, spot.z);
    sim.player.state = 'air';
    sim.step({}, 2); // free fall + settle
    const p = sim.player;
    expect(p.state).toBe('ground');
    const g = world.groundAt(p.pos.x, p.pos.z, p.pos.y);
    expect(p.pos.y).toBeCloseTo(g.y, 3);
    expect(p.vel.y).toBe(0);
    expect(sim.log).toContain('land');
  });

  it('stays put when spawned at base camp', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    sim.step({}, 1);
    expect(sim.player.state).toBe('ground');
    // spawn point sits 6cm above the platform; the capsule settles onto it
    expect(sim.player.pos.y).toBeCloseTo(world.ledges[0].topY, 3);
  });
});

describe('player: jumping', () => {
  it('jump produces upward velocity, costs 6 stamina, then lands', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    sim.step({}, 0.2); // settle onto the platform
    const y0 = sim.player.pos.y;
    sim.step({ jump: true }); // single edge-triggered substep
    const p = sim.player;
    expect(p.state).toBe('air');
    expect(p.vel.y).toBeGreaterThan(6); // JUMP_V 7.2 minus one gravity substep
    expect(p.stamina).toBeCloseTo(STAM.max - STAM.groundJump, 3);
    expect(sim.log).toContain('jump');
    // track the arc
    let apex = y0;
    for (let t = 0; t < 2; t += DT * 10) {
      sim.step({}, DT * 10);
      apex = Math.max(apex, p.pos.y);
    }
    expect(apex - y0).toBeGreaterThan(1); // ~1.18m ballistic apex for 7.2 m/s @ g=22
    expect(p.state).toBe('ground');
    expect(p.pos.y).toBeCloseTo(y0, 3); // lands back on the camp platform
  });
});

describe('player: grab → hang', () => {
  it('grab raycast enters HANG and gravity stops', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    const hold = world.holds[2];
    aimAtHold(sim, hold);
    sim.step({ grab: true });
    const p = sim.player;
    expect(p.state).toBe('hang');
    expect(sim.log).toContain('grab');
    // hanging: no gravity, position frozen while idle
    const posAfterGrab = p.pos.clone();
    sim.step({ grab: true }, 1);
    expect(p.state).toBe('hang');
    expect(p.pos.distanceTo(posAfterGrab)).toBeLessThan(1e-6);
    expect(p.vel.length()).toBe(0);
  });

  it('releasing grab drops the player (gravity resumes)', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    aimAtHold(sim, world.holds[2]);
    sim.step({ grab: true });
    expect(sim.player.state).toBe('hang');
    const y0 = sim.player.pos.y;
    sim.step({}, 0.5); // grab released → airborne
    expect(sim.player.state).not.toBe('hang');
    expect(sim.player.pos.y).toBeLessThan(y0);
  });
});

describe('player: stamina (§11.3)', () => {
  it('drains 2.5/s while hanging idle', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    aimAtHold(sim, world.holds[3]);
    sim.step({ grab: true });
    expect(sim.player.state).toBe('hang');
    sim.step({ grab: true }, 1);
    expect(sim.player.stamina).toBeCloseTo(STAM.max - STAM.hangIdle, 1);
  });

  it('drains 6/s while traversing, and the traverse moves along the wall', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    const hold = world.holds[3];
    aimAtHold(sim, hold);
    sim.step({ grab: true });
    const before = sim.player.pos.clone();
    sim.step({ grab: true, moveX: 1 }, 1);
    const p = sim.player;
    expect(p.state).toBe('hang');
    expect(p.stamina).toBeCloseTo(STAM.max - STAM.hangMove, 1);
    expect(p.pos.distanceTo(before)).toBeGreaterThan(0.3);
    // tether: body stays near the held point (TETHER 1.45 + body offset ~0.5)
    expect(Math.hypot(p.pos.x - hold.pos.x, p.pos.z - hold.pos.z)).toBeLessThan(1.45 + 0.51);
  });

  it('regenerates 25/s on natural ground after the 0.6s delay', () => {
    const sim = new Sim(world);
    const spot = findFlatSpot(world);
    sim.player.pos.set(spot.x, world.heightAt(spot.x, spot.z) + 2, spot.z);
    sim.player.state = 'air';
    sim.step({}, 1.5); // land + settle
    expect(sim.player.state).toBe('ground');
    sim.player.stamina = 50;
    // simulate a fresh drain right now — regen must wait 0.6s
    (sim.player as unknown as { lastDrainT: number }).lastDrainT = sim.now;
    sim.step({}, 0.5);
    expect(sim.player.stamina).toBeCloseTo(50, 3); // still inside the delay window
    sim.step({}, 0.5); // 0.4s of active regen → +10
    expect(sim.player.stamina).toBeCloseTo(50 + STAM.regenGround * 0.4, 0);
  });

  it('regenerates 40/s on rest ledges', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0); // base camp ledge
    sim.step({}, 0.2);
    sim.player.stamina = 50;
    sim.step({}, 0.5); // lastDrainT is long past → regen active immediately
    expect(sim.player.stamina).toBeCloseTo(50 + STAM.regenLedge * 0.5, 0);
  });

  it('wall jump costs 12 stamina and pushes off along the wall normal', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    const hold = world.holds[4];
    aimAtHold(sim, hold);
    sim.step({ grab: true });
    expect(sim.player.state).toBe('hang');
    sim.step({ grab: true, jump: true });
    const p = sim.player;
    expect(p.state).toBe('air');
    expect(sim.log).toContain('walljump');
    // one idle-hang drain substep (2.5/120) + the 12 cost
    expect(p.stamina).toBeCloseTo(STAM.max - STAM.wallJump - STAM.hangIdle * DT, 1);
    expect(p.vel.y).toBeCloseTo(6.2, 3);
    const nh = new THREE.Vector3(p.hangNormal.x, 0, p.hangNormal.z).normalize();
    const vh = new THREE.Vector3(p.vel.x, 0, p.vel.z);
    expect(vh.length()).toBeCloseTo(4.2, 3);
    expect(vh.normalize().dot(nh)).toBeGreaterThan(0.99);
  });

  it('empty stamina while hanging → forced release + ~1.2s exhaustion lockout', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    const hold = world.holds[2];
    aimAtHold(sim, hold);
    sim.step({ grab: true });
    expect(sim.player.state).toBe('hang');
    sim.player.stamina = 1;
    // 2.5/s idle drain → empty in 0.4s → forced release
    for (let t = 0; t < 1 && sim.player.state === 'hang'; t += DT) sim.step({ grab: true });
    const p = sim.player;
    expect(p.state).toBe('air');
    expect(p.stamina).toBe(0);
    expect(sim.log).toContain('exhausted');
    expect(p.exhausted).toBe(true);

    // hover in front of a hold with grab held: the lockout must block re-grab
    // for ~1.2s (0.9s here stays safely inside the window)
    const regrab = world.holds[3];
    for (let t = 0; t < 0.9; t += DT) {
      aimAtHold(sim, regrab); // pin position (hover) + aim
      sim.step({ grab: true });
      expect(p.state).toBe('air');
      expect(p.canGrab).toBe(false);
    }
    expect(p.exhausted).toBe(true);

    // after ~1.2s total the lockout expires and the grab goes through
    for (let t = 0; t < 0.5 && p.state !== 'hang'; t += DT) {
      aimAtHold(sim, regrab);
      sim.step({ grab: true });
    }
    expect(p.state).toBe('hang');
    expect(p.exhausted).toBe(false);
  });
});

describe('player: fall rescue + summit', () => {
  it('falling more than 18m respawns at the checkpoint', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    sim.step({}, 0.1);
    sim.player.pos.y += 25;
    sim.player.state = 'air';
    // long fall → auto rescue; stop the substep it happens on
    for (let t = 0; t < 3 && !sim.log.includes('respawn'); t += DT) sim.step({});
    const p = sim.player;
    expect(sim.log).toContain('respawn');
    expect(p.state).toBe('ground');
    expect(p.falls).toBe(1);
    // respawn sets 60; the same substep already applies one ledge-regen tick
    expect(p.stamina).toBeCloseTo(60, 0);
    const cp = world.ledges[0];
    expect(p.pos.distanceTo(cp.spawn)).toBeLessThan(0.01);
  });

  it('a short fall does NOT trigger rescue', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    sim.step({}, 0.1);
    sim.player.pos.y += 6;
    sim.player.state = 'air';
    sim.step({}, 2);
    expect(sim.log).not.toContain('respawn');
    expect(sim.player.falls).toBe(0);
  });

  it('standing on the summit plateau triggers the summit event', () => {
    const sim = new Sim(world);
    sim.player.spawnAt(0);
    sim.player.pos.set(1.5, world.summitPos.y + 1, 0);
    sim.player.state = 'air';
    sim.step({}, 1.5);
    const p = sim.player;
    expect(p.state).toBe('ground');
    expect(p.summitReached).toBe(true);
    expect(sim.log).toContain('summit');
  });
});
