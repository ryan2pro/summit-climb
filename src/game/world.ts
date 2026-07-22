/**
 * World — seeded procedural mountain (design.md §11.1).
 *
 * Everything derives from a single seeded PRNG chain (lib/prng xmur3 →
 * mulberry32) consumed in a fixed order: noise table → route → ledges →
 * props. `Math.random` / `Date.now` are never used, so every client builds a
 * bit-identical mountain from the same seed. Generation is chunked across
 * frames (<1.5s total) with progress callbacks for the loading screen.
 *
 * Layout: H≈150m cone with 3-octave seeded value-noise ridge + terracing,
 * altitude zones (meadow 0–30% / rock 30–72% / snow 72–96% / summit plateau
 * 96–100%), a seeded spiral route of grabbable holds from base camp to the
 * summit cap, rest-ledge checkpoints every 8–12 holds, instanced pines /
 * rocks / clouds, circling birds and the summit pennant.
 *
 * Generation logs `[gen] seed=… verts=… holds=…` — identical seeds must
 * yield identical hold counts.
 */

import * as THREE from 'three';
import { rngFromSeed, randRange, randInt } from '@/lib/prng';
import type { ResolvedQuality } from './engine';
import { QUALITY_PRESETS } from './engine';

export const MOUNTAIN_H = 150;
export const MOUNTAIN_R = 95;
const WORLD_R = 175;
const SEGS = 192;
const RINGS = 96;
const TAU = Math.PI * 2;
const TERRACE_STEP = 2.5;
const TERRACE_BLEND = 0.35;
/** vertical span of the hold route (last holds sit just under the plateau rim) */
const ROUTE_TOP_Y = MOUNTAIN_H - 0.6;

/* ----------------------------- palette (§2.2) ----------------------------- */
const C = {
  meadow: new THREE.Color('#A9B388'),
  forest: new THREE.Color('#6F8F67'),
  trunk: new THREE.Color('#8A6B4E'),
  rockLo: new THREE.Color('#B99B7B'),
  rockMid: new THREE.Color('#9B8571'),
  rockHi: new THREE.Color('#8A7D76'),
  snow: new THREE.Color('#F2EFE7'),
  holdA: new THREE.Color('#C8A06B'),
  holdB: new THREE.Color('#E8A94C'),
  wood: new THREE.Color('#8A6B4E'),
  woodDark: new THREE.Color('#6E543C'),
  terracotta: new THREE.Color('#D0713F'),
  cream: new THREE.Color('#F6F2E9'),
  ember: new THREE.Color('#E8A94C'),
};

export interface WorldGenProgress {
  label: string;
  frac: number; // 0..0.9 (last 10% = peer wait, owned by the page)
}

export interface Hold {
  index: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  scale: number;
  /** ledge index if a rest platform sits at this hold, else -1 */
  ledge: number;
}

export interface Ledge {
  index: number;
  name: string;
  center: THREE.Vector3;
  topY: number;
  /** yaw so local +z points outward from the wall */
  theta: number;
  cos: number;
  sin: number;
  halfX: number; // 1.3 tangent half-width
  halfZ: number; // 0.75 outward half-depth
  spawn: THREE.Vector3;
  altitude: number;
  holdIndex: number;
}

export interface GrabHit {
  /** 'wall' = bare steep terrain (PEAK-style universal climbing) */
  kind: 'hold' | 'ledge' | 'wall';
  index: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  dist: number;
}

interface SphereCollider {
  x: number;
  y: number;
  z: number;
  r: number;
}

const nextChunk = () => new Promise<void>((r) => setTimeout(r, 0));
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* --------------------- seeded 3-octave ridge value noise --------------------- */

function makeNoise(rng: () => number) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const hash = (x: number, y: number) => perm[((x & 255) + perm[y & 255]) & 255] / 255;
  const fade = (t: number) => t * t * (3 - 2 * t);
  const noise2 = (x: number, y: number) => {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const xf = x - X;
    const yf = y - Y;
    const u = fade(xf);
    const v = fade(yf);
    const a = hash(X, Y);
    const b = hash(X + 1, Y);
    const c = hash(X, Y + 1);
    const d = hash(X + 1, Y + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  // 3-octave ridged value noise → ~[0,1]
  return (x: number, y: number) => {
    let f = 0;
    let amp = 0.55;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < 3; o++) {
      const n = noise2(x * freq, y * freq);
      f += amp * (1 - Math.abs(n * 2 - 1));
      norm += amp;
      amp *= 0.5;
      freq *= 2.13;
    }
    return f / norm;
  };
}

/* ------------------------------ burst particles ------------------------------ */

const BURST_MAX = 460;

class BurstSystem {
  readonly mesh: THREE.InstancedMesh;
  private parts: {
    active: boolean;
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    rot: THREE.Euler;
    rv: THREE.Vector3;
    life: number;
    maxLife: number;
    size: number;
    gravity: number;
  }[] = [];
  private cursor = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor() {
    const geo = new THREE.IcosahedronGeometry(0.09, 0);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.96 });
    this.mesh = new THREE.InstancedMesh(geo, mat, BURST_MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = BURST_MAX;
    for (let i = 0; i < BURST_MAX; i++) {
      this.parts.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        rv: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        size: 1,
        gravity: 8,
      });
      this.mesh.setMatrixAt(i, this.hidden);
      this.mesh.setColorAt(i, C.cream);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  spawn(
    at: THREE.Vector3,
    opts: { count: number; colors: THREE.Color[]; speed: number; up: number; life: number; gravity: number; size: number },
  ): void {
    for (let n = 0; n < opts.count; n++) {
      const p = this.parts[this.cursor];
      this.cursor = (this.cursor + 1) % BURST_MAX;
      p.active = true;
      p.pos.copy(at);
      const a = Math.random() * TAU;
      const r = Math.random();
      p.vel.set(
        Math.cos(a) * opts.speed * r,
        opts.up * (0.5 + Math.random() * 0.8),
        Math.sin(a) * opts.speed * r,
      );
      p.rot.set(Math.random() * TAU, Math.random() * TAU, 0);
      p.rv.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
      p.maxLife = opts.life * (0.7 + Math.random() * 0.6);
      p.life = p.maxLife;
      p.size = opts.size * (0.7 + Math.random() * 0.7);
      p.gravity = opts.gravity;
      this.mesh.setColorAt(this.cursor, opts.colors[n % opts.colors.length]);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < BURST_MAX; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
      any = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.mesh.setMatrixAt(i, this.hidden);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.rot.x += p.rv.x * dt;
      p.rot.y += p.rv.y * dt;
      p.rot.z += p.rv.z * dt;
      const s = p.size * Math.min(1, (p.life / p.maxLife) * 2.2);
      this.q.setFromEuler(p.rot);
      this.s.setScalar(Math.max(0.001, s));
      this.m4.compose(p.pos, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m4);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ---------------------------------- world ---------------------------------- */

export class World {
  readonly group = new THREE.Group();
  readonly holds: Hold[] = [];
  readonly ledges: Ledge[] = [];
  readonly summitPos = new THREE.Vector3();
  readonly summitRadius = 4;
  readonly heightM = MOUNTAIN_H;
  readonly vertCount: number;
  readonly seed: number;

  private fbm: (x: number, y: number) => number;
  /** internal: sphere colliders (holds/trees/rocks) — filled during generation */
  colliders: SphereCollider[] = [];
  private highlight: THREE.Mesh;
  private highlightMat: THREE.MeshStandardMaterial;
  private bursts = new BurstSystem();
  /** internal: campfire flames, filled during generation */
  flames: { mesh: THREE.Mesh; phase: number }[] = [];
  /** internal: waving flags/pennants, filled during generation */
  flags: { mesh: THREE.Object3D; phase: number; amp: number }[] = [];
  /** internal: drifting cloud layer */
  cloudGroup = new THREE.Group();
  /** internal: circling birds, filled during generation */
  birds: { group: THREE.Group; wingL: THREE.Mesh; wingR: THREE.Mesh; r: number; h: number; speed: number; a: number; phase: number }[] = [];

  constructor(seed: number, fbm: (x: number, y: number) => number, vertCount: number) {
    this.seed = seed;
    this.fbm = fbm;
    this.vertCount = vertCount;
    // hold-target highlight (amber emissive pulse, §2.2)
    this.highlightMat = new THREE.MeshStandardMaterial({
      color: '#E8A94C',
      emissive: '#E8A94C',
      emissiveIntensity: 1.4,
      roughness: 1,
      metalness: 0,
      flatShading: true,
      transparent: true,
      opacity: 0.9,
    });
    this.highlight = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), this.highlightMat);
    this.highlight.visible = false;
    this.group.add(this.highlight);
    this.group.add(this.bursts.mesh);
    this.group.add(this.cloudGroup);
  }

  /* ---------------------------- terrain queries ---------------------------- */

  /** Analytic terrain height — the single source of truth for mesh + physics. */
  heightAt = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const cone = MOUNTAIN_H * Math.max(0, 1 - r / MOUNTAIN_R);
    let h: number;
    if (cone <= 0) {
      h = (this.fbm(x * 0.02 + 11.7, z * 0.02 - 5.3) - 0.5) * 2.4;
    } else {
      const n = this.fbm(x * 0.012, z * 0.012);
      const n2 = this.fbm(x * 0.05 + 7.3, z * 0.05 - 2.1);
      const topBlend = sstep(MOUNTAIN_H * 0.55, MOUNTAIN_H * 0.92, cone);
      const mod = (0.66 + 0.55 * n) * (1 - topBlend) + topBlend;
      h = cone * mod + (n2 - 0.5) * 5 * (0.25 + cone / MOUNTAIN_H) * (1 - topBlend);
      // summit plateau (§11.1 96–100%): walkable flat disc r<6 at exactly H,
      // smooth steep cap wall blending back to the natural cone by r=16
      if (r < 16) h = MOUNTAIN_H + (h - MOUNTAIN_H) * sstep(6, 16, r);
    }
    if (r > 8) {
      const q = Math.round(h / TERRACE_STEP) * TERRACE_STEP;
      h += (q - h) * TERRACE_BLEND;
    }
    return h;
  };

  gradientAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    const e = 0.4;
    out.x = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    out.z = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return out;
  }

  slopeAt(x: number, z: number): number {
    const g = this.gradientAt(x, z, { x: 0, z: 0 });
    return Math.hypot(g.x, g.z);
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const g = this.gradientAt(x, z, { x: 0, z: 0 });
    return out.set(-g.x, 1, -g.z).normalize();
  }

  /** Ground height including rest-ledge platforms the player can stand on. */
  groundAt(x: number, z: number, feetY: number): { y: number; ledge: Ledge | null } {
    let y = this.heightAt(x, z);
    let ledge: Ledge | null = null;
    for (const L of this.ledges) {
      const dx = x - L.center.x;
      const dz = z - L.center.z;
      const lx = dx * L.cos - dz * L.sin;
      const lz = dx * L.sin + dz * L.cos;
      if (Math.abs(lx) <= L.halfX && Math.abs(lz) <= L.halfZ && feetY >= L.topY - 0.55 && L.topY > y) {
        y = L.topY;
        ledge = L;
      }
    }
    return { y, ledge };
  }

  /** Push a sphere out of hold/tree/rock colliders + ledge sides. */
  collide(center: THREE.Vector3, radius: number): void {
    for (let iter = 0; iter < 3; iter++) {
      for (const c of this.colliders) {
        const dx = center.x - c.x;
        const dy = center.y - c.y;
        const dz = center.z - c.z;
        const rr = c.r + radius;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (rr - d) / d;
        center.x += dx * push;
        center.y += dy * push;
        center.z += dz * push;
      }
      // ledge platform sides (solid boxes below their tops)
      for (const L of this.ledges) {
        const dx = center.x - L.center.x;
        const dz = center.z - L.center.z;
        const feetY = center.y - 0.6;
        if (feetY > L.topY - 0.3 || feetY < L.topY - 2.4) continue;
        const lx = dx * L.cos - dz * L.sin;
        const lz = dx * L.sin + dz * L.cos;
        const ex = L.halfX + radius;
        const ez = L.halfZ + radius;
        if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
        const px = ex - Math.abs(lx);
        const pz = ez - Math.abs(lz);
        if (px < pz) {
          const s = Math.sign(lx) || 1;
          center.x += L.cos * s * px;
          center.z -= L.sin * s * px;
        } else {
          const s = Math.sign(lz) || 1;
          center.x += L.sin * s * pz;
          center.z += L.cos * s * pz;
        }
      }
    }
    // soft world-edge wall so players can't walk off the diorama
    const rr = Math.hypot(center.x, center.z);
    if (rr > 165) {
      const s = 165 / rr;
      center.x *= s;
      center.z *= s;
    }
  }

  /* ------------------------------ grab raycast ------------------------------ */

  /** Raycast against hold spheres + ledge slabs (§11.2, range 2.4m). */
  grabRaycast(origin: THREE.Vector3, dir: THREE.Vector3, range: number): GrabHit | null {
    let best: GrabHit | null = null;
    let bestT = range;
    // holds — ray/sphere
    for (const h of this.holds) {
      const cr = 0.5 * h.scale + 0.16;
      const ox = h.pos.x - origin.x;
      const oy = h.pos.y - origin.y;
      const oz = h.pos.z - origin.z;
      const tca = ox * dir.x + oy * dir.y + oz * dir.z;
      if (tca < 0 || tca - cr > bestT) continue;
      const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
      if (d2 > cr * cr) continue;
      const t = tca - Math.sqrt(cr * cr - d2);
      if (t < 0.05 || t > bestT) continue;
      bestT = t;
      best = {
        kind: 'hold',
        index: h.index,
        point: h.pos.clone(),
        normal: h.normal.clone(),
        dist: t,
      };
    }
    // ledges — ray/slab in local frame
    for (const L of this.ledges) {
      const ox = origin.x - L.center.x;
      const oy = origin.y - L.center.y;
      const oz = origin.z - L.center.z;
      const lox = ox * L.cos - oz * L.sin;
      const loz = ox * L.sin + oz * L.cos;
      const ldx = dir.x * L.cos - dir.z * L.sin;
      const ldz = dir.x * L.sin + dir.z * L.cos;
      const ldy = dir.y;
      const hy = 0.18;
      let tmin = 0.05;
      let tmax = bestT;
      let face = -1;
      let ok = true;
      const o = [lox, oy, loz];
      const d = [ldx, ldy, ldz];
      const e = [L.halfX, hy, L.halfZ];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-8) {
          if (Math.abs(o[a]) > e[a]) {
            ok = false;
            break;
          }
          continue;
        }
        let t1 = (-e[a] - o[a]) / d[a];
        let t2 = (e[a] - o[a]) / d[a];
        let f = a * 2;
        if (t1 > t2) {
          const tt = t1;
          t1 = t2;
          t2 = tt;
          f = a * 2 + 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          face = f;
        }
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) {
          ok = false;
          break;
        }
      }
      if (!ok || face < 0 || tmin >= bestT) continue;
      bestT = tmin;
      const px = origin.x + dir.x * tmin;
      const py = origin.y + dir.y * tmin;
      const pz = origin.z + dir.z * tmin;
      const n = new THREE.Vector3();
      const axis = face >> 1;
      const sign = face & 1 ? 1 : -1;
      if (axis === 0) n.set(L.cos * sign, 0, -L.sin * sign);
      else if (axis === 1) n.set(0, sign, 0);
      else n.set(L.sin * sign, 0, L.cos * sign);
      best = { kind: 'ledge', index: L.index, point: new THREE.Vector3(px, py, pz), normal: n, dist: tmin };
    }
    return best;
  }

  /**
   * PEAK-style universal climbing probe: march the grab ray against the
   * analytic heightfield; the first terrain contact steep enough to hold
   * (normal.y < 0.6 ⇔ slope ≥ ~1.67) is grabbable. Deterministic: fixed
   * 0.25m march + 4 bisection refinements, no rng.
   */
  wallProbe(origin: THREE.Vector3, dir: THREE.Vector3, range: number): GrabHit | null {
    const step = 0.25;
    let prevT = 0.05;
    for (let t = 0.05 + step; t <= range + 1e-6; t += step) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      const clear = y - this.heightAt(x, z);
      if (clear <= 0) {
        // refine the surface crossing between prevT (clear) and t (inside)
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 4; i++) {
          const mid = (lo + hi) / 2;
          const my = origin.y + dir.y * mid;
          if (my - this.heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid) > 0) lo = mid;
          else hi = mid;
        }
        const ct = (lo + hi) / 2;
        const cx = origin.x + dir.x * ct;
        const cz = origin.z + dir.z * ct;
        const n = this.normalAt(cx, cz, new THREE.Vector3());
        if (n.y >= 0.6) return null; // too shallow to cling to
        return {
          kind: 'wall',
          index: -1,
          point: new THREE.Vector3(cx, origin.y + dir.y * ct, cz),
          normal: n,
          dist: ct,
        };
      }
      prevT = t;
    }
    return null;
  }

  /** Amber emissive pulse on the currently targeted hold (§2.2). */
  setTargetHold(hit: GrabHit | null): void {
    if (!hit) {
      this.highlight.visible = false;
      return;
    }
    if (hit.kind === 'hold') {
      const h = this.holds[hit.index];
      this.highlight.position.copy(h.pos).addScaledVector(h.normal, 0.04);
      this.highlight.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.normal);
      this.highlight.scale.set(h.scale * 1.25, h.scale * 0.62, h.scale);
      this.highlight.visible = true;
    } else {
      this.highlight.visible = true;
      this.highlight.position.copy(hit.point).addScaledVector(hit.normal, 0.12);
      this.highlight.quaternion.identity();
      this.highlight.scale.setScalar(0.42);
    }
  }

  /* ------------------------------ VFX / events ------------------------------ */

  burstDust(at: THREE.Vector3): void {
    this.bursts.spawn(at, {
      count: 10,
      colors: [C.rockLo, C.rockMid, C.cream],
      speed: 1.6,
      up: 1.4,
      life: 0.55,
      gravity: 7,
      size: 0.8,
    });
  }

  /** amber contact flash on successful grab (game.md §3) */
  burstAmber(at: THREE.Vector3): void {
    this.bursts.spawn(at, {
      count: 8,
      colors: [C.ember, C.cream],
      speed: 1.1,
      up: 1.2,
      life: 0.4,
      gravity: 2,
      size: 0.7,
    });
  }

  igniteCampfire(ledgeIndex: number): void {
    const L = this.ledges[ledgeIndex];
    if (!L) return;
    this.bursts.spawn(L.center.clone().add(new THREE.Vector3(0, 0.4, 0)), {
      count: 26,
      colors: [C.ember, C.terracotta, C.cream],
      speed: 1.2,
      up: 2.6,
      life: 0.9,
      gravity: 3,
      size: 0.85,
    });
  }

  burstConfetti(at: THREE.Vector3): void {
    this.bursts.spawn(at, {
      count: 200,
      colors: [C.terracotta, C.ember, new THREE.Color('#7FA07A'), C.cream],
      speed: 3.2,
      up: 7.5,
      life: 3,
      gravity: 5,
      size: 1,
    });
  }

  /* -------------------------------- per-frame -------------------------------- */

  update(dt: number, t: number): void {
    // hold-target amber pulse
    if (this.highlight.visible) {
      this.highlightMat.emissiveIntensity = 1.5 + Math.sin(t * 6.5) * 0.85;
    }
    // campfires
    for (const f of this.flames) {
      const s = 1 + Math.sin(t * 13 + f.phase) * 0.18 + Math.sin(t * 29 + f.phase * 2) * 0.08;
      f.mesh.scale.set(1, s, 1);
    }
    // flags / pennants
    for (const f of this.flags) {
      f.mesh.rotation.y = Math.sin(t * 2.1 + f.phase) * f.amp;
    }
    // drifting clouds
    this.cloudGroup.rotation.y += dt * 0.0035;
    // circling birds
    for (const b of this.birds) {
      b.a += b.speed * dt;
      const x = Math.cos(b.a) * b.r;
      const z = Math.sin(b.a) * b.r;
      b.group.position.set(x, b.h + Math.sin(t * 0.7 + b.phase) * 2.5, z);
      b.group.rotation.y = -b.a - Math.PI / 2 + (b.speed < 0 ? Math.PI : 0);
      const flap = Math.sin(t * 9 + b.phase) * 0.55;
      b.wingL.rotation.z = 0.25 + flap;
      b.wingR.rotation.z = -0.25 - flap;
    }
    this.bursts.update(dt);
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.group.clear();
  }
}

/* ------------------------------ generation ------------------------------ */

export async function generateWorld(
  seed: number,
  quality: ResolvedQuality,
  onProgress: (p: WorldGenProgress) => void,
): Promise<World> {
  const rng = rngFromSeed(`summit-world-${seed}`);
  const fbm = makeNoise(rng);
  const preset = QUALITY_PRESETS[quality];
  const world = new World(seed, fbm, 1 + RINGS * SEGS + SEGS);
  const g = world.group;

  /* ---- step 1: terrain mesh (40%) ---- */
  onProgress({ label: '雕刻山体…', frac: 0.02 });
  const vertTotal = 1 + (RINGS + 1) * SEGS;
  const pos = new Float32Array(vertTotal * 3);
  const col = new Float32Array(vertTotal * 3);
  const idx = new Uint32Array(SEGS * 3 + RINGS * SEGS * 6);
  const heightAt = world.heightAt;
  const grad = { x: 0, z: 0 };
  const tmpColor = new THREE.Color();
  const rockLerp = (t: number, out: THREE.Color) => {
    if (t < 0.5) out.lerpColors(C.rockLo, C.rockMid, t * 2);
    else out.lerpColors(C.rockMid, C.rockHi, t * 2 - 1);
    return out;
  };
  const colorAt = (x: number, z: number, y: number, slope: number) => {
    const f = Math.min(1, Math.max(0, y / MOUNTAIN_H));
    const m = fbm(x * 0.11 + 3.1, z * 0.11 - 8.7) - 0.5;
    const ff = f + m * 0.06;
    if (slope > 0.8) {
      rockLerp(Math.min(1, ff * 1.15), tmpColor);
    } else if (ff < 0.3) {
      const fMix = sstep(0.3, 0.72, fbm(x * 0.06 - 9.2, z * 0.06 + 4.4));
      tmpColor.lerpColors(C.meadow, C.forest, fMix);
    } else if (ff < 0.72) {
      rockLerp((ff - 0.3) / 0.42, tmpColor);
    } else if (ff < 0.96) {
      tmpColor.lerpColors(C.rockHi, C.snow, sstep(0, 1, (ff - 0.72) / 0.24));
    } else {
      tmpColor.copy(C.snow);
    }
    const b = 1 + m * 0.12;
    tmpColor.r = Math.min(1, tmpColor.r * b);
    tmpColor.g = Math.min(1, tmpColor.g * b);
    tmpColor.b = Math.min(1, tmpColor.b * b);
    return tmpColor;
  };

  // center vertex
  pos[1] = heightAt(0, 0);
  colorAt(0, 0, pos[1], 0);
  col[0] = tmpColor.r;
  col[1] = tmpColor.g;
  col[2] = tmpColor.b;
  let vi = 1;
  for (let i = 1; i <= RINGS + 1; i++) {
    const skirt = i === RINGS + 1;
    const rr = skirt ? 192 : WORLD_R * Math.pow(i / RINGS, 1.55);
    for (let j = 0; j < SEGS; j++) {
      const a = (j / SEGS) * TAU;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      let y = heightAt(x, z);
      if (skirt) y -= 16;
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = z;
      world.gradientAt(x, z, grad);
      colorAt(x, z, y, Math.hypot(grad.x, grad.z));
      col[vi * 3] = tmpColor.r;
      col[vi * 3 + 1] = tmpColor.g;
      col[vi * 3 + 2] = tmpColor.b;
      vi++;
    }
    if (i % 10 === 0) {
      onProgress({ label: '雕刻山体…', frac: 0.02 + 0.36 * (i / (RINGS + 1)) });
      await nextChunk();
    }
  }
  let ii = 0;
  for (let j = 0; j < SEGS; j++) {
    idx[ii++] = 0;
    idx[ii++] = 1 + ((j + 1) % SEGS);
    idx[ii++] = 1 + j;
  }
  for (let i = 1; i <= RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = 1 + (i - 1) * SEGS + j;
      const b = 1 + (i - 1) * SEGS + ((j + 1) % SEGS);
      const c = 1 + i * SEGS + j;
      const d = 1 + i * SEGS + ((j + 1) % SEGS);
      idx[ii++] = a;
      idx[ii++] = b;
      idx[ii++] = c;
      idx[ii++] = b;
      idx[ii++] = d;
      idx[ii++] = c;
    }
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  terrainGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
    metalness: 0,
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.frustumCulled = false;
  g.add(terrain);

  /* ---- step 2: spiral hold route (30%) ---- */
  onProgress({ label: '布置岩点…', frac: 0.42 });
  await nextChunk();

  const surfaceRadius = (theta: number, y: number): number => {
    const cx = Math.cos(theta);
    const sz = Math.sin(theta);
    let prevH = heightAt(cx * (MOUNTAIN_R + 28), sz * (MOUNTAIN_R + 28));
    for (let rr = MOUNTAIN_R + 28; rr > 1.5; rr -= 1) {
      const h = heightAt(cx * (rr - 1), sz * (rr - 1));
      if (h >= y && prevH < y) {
        let lo = rr - 1;
        let hi = rr;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          if (heightAt(cx * mid, sz * mid) >= y) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      }
      prevH = h;
    }
    return Math.max(2, MOUNTAIN_R * (1 - y / MOUNTAIN_H));
  };

  const nrm = new THREE.Vector3();
  const addLedge = (hold: Hold) => {
    const idxL = world.ledges.length;
    const n = hold.normal;
    const nh = { x: n.x, z: n.z };
    const nl = Math.hypot(nh.x, nh.z) || 1;
    nh.x /= nl;
    nh.z /= nl;
    const theta = Math.atan2(nh.x, nh.z);
    const topY = hold.pos.y + 0.1;
    const center = new THREE.Vector3(
      hold.pos.x + nh.x * -0.1,
      topY - 0.14,
      hold.pos.z + nh.z * -0.1,
    );
    const altitude = Math.round(topY);
    const ledge: Ledge = {
      index: idxL,
      name: idxL === 0 ? `大本营 · ${altitude}m` : `营地 ${idxL} · ${altitude}m`,
      center,
      topY,
      theta,
      cos: Math.cos(theta),
      sin: Math.sin(theta),
      halfX: 1.3,
      halfZ: 0.75,
      spawn: new THREE.Vector3(center.x + nh.x * 0.2, topY + 0.06, center.z + nh.z * 0.2),
      altitude,
      holdIndex: hold.index,
    };
    world.ledges.push(ledge);
    hold.ledge = idxL;
    return ledge;
  };

  let theta = rng() * TAU;
  let y = 4;
  let ledgeCountdown = -1; // base camp first, then every 8–12 holds
  let hIdx = 0;
  while (y < ROUTE_TOP_Y) {
    const tier = y < 50 ? 0 : y < 100 ? 1 : 2;
    const rr = surfaceRadius(theta, y);
    const x = Math.cos(theta) * rr;
    const z = Math.sin(theta) * rr;
    const hy = heightAt(x, z);
    world.normalAt(x, z, nrm);
    const scale = tier === 2 ? randRange(rng, 0.85, 1.7) : randRange(rng, 0.9, 1.6);
    const hold: Hold = {
      index: hIdx++,
      pos: new THREE.Vector3(x + nrm.x * 0.12, hy + nrm.y * 0.12, z + nrm.z * 0.12),
      normal: nrm.clone(),
      scale,
      ledge: -1,
    };
    world.holds.push(hold);
    if (ledgeCountdown < 0) {
      addLedge(hold);
      ledgeCountdown = randInt(rng, 8, 12);
    } else if (--ledgeCountdown === 0) {
      addLedge(hold);
      ledgeCountdown = randInt(rng, 8, 12);
    }
    // advance along the spiral — gap capped at 3.7m so every hop is
    // climbable (tether reach 1.45 + raycast 2.4 + wall jump), top third
    // runs widest, requiring jumps (§11.1)
    let arc = tier === 0 ? randRange(rng, 0.6, 1.3) : tier === 1 ? randRange(rng, 0.9, 1.9) : randRange(rng, 1.3, 2.3);
    let dy = tier === 0 ? randRange(rng, 1.9, 2.5) : tier === 1 ? randRange(rng, 2.1, 2.9) : randRange(rng, 2.4, 3.2);
    const prev = hold.pos;
    // shrink arc/dy until the hop fits the 3.7m cap. The retry loop draws
    // no rng, so extra tries never perturb the deterministic stream — they
    // only prevent the rare >3.7m gap the old 3-try cap could accept.
    for (let tries = 0; tries < 8; tries++) {
      const rGuess = Math.max(6, MOUNTAIN_R * (1 - (y + dy) / MOUNTAIN_H));
      const nt = theta + arc / rGuess;
      const ny = Math.min(ROUTE_TOP_Y + 0.5, y + dy);
      const r2 = surfaceRadius(nt, ny);
      const gap = Math.hypot(Math.cos(nt) * r2 - prev.x, heightAt(Math.cos(nt) * r2, Math.sin(nt) * r2) - prev.y, Math.sin(nt) * r2 - prev.z);
      if (gap <= 3.7 || tries === 7) {
        theta = nt;
        y = ny;
        break;
      }
      arc *= 0.72;
      dy *= 0.78;
    }
    if (hIdx % 12 === 0) {
      onProgress({ label: '布置岩点…', frac: 0.42 + 0.24 * Math.min(1, y / ROUTE_TOP_Y) });
      await nextChunk();
    }
  }

  // summit position (plateau center)
  world.summitPos.set(0, heightAt(0, 0), 0);

  // hold instanced mesh
  const holdGeo = new THREE.IcosahedronGeometry(1, 0);
  const holdMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    flatShading: true,
    roughness: 1,
    metalness: 0,
  });
  const holdMesh = new THREE.InstancedMesh(holdGeo, holdMat, world.holds.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const sv = new THREE.Vector3();
  world.holds.forEach((h, i) => {
    q.setFromUnitVectors(up, h.normal);
    sv.set(h.scale * 1.1, h.scale * 0.52, h.scale * 0.85);
    m4.compose(h.pos, q, sv);
    holdMesh.setMatrixAt(i, m4);
    tmpColor.lerpColors(C.holdA, C.holdB, 0.15 + rng() * 0.3);
    holdMesh.setColorAt(i, tmpColor);
    // holds hosting a rest ledge must not shove players off the platform
    if (h.ledge < 0) world.colliders.push({ x: h.pos.x, y: h.pos.y, z: h.pos.z, r: 0.4 * h.scale });
  });
  holdMesh.instanceMatrix.needsUpdate = true;
  if (holdMesh.instanceColor) holdMesh.instanceColor.needsUpdate = true;
  g.add(holdMesh);

  /* ---- step 3: ledges, flags, campfires + props (20%) ---- */
  onProgress({ label: '种下松树…', frac: 0.68 });
  await nextChunk();

  // rest ledges: wooden platform + struts + flag + campfire
  const platformGeo = new THREE.BoxGeometry(2.6, 0.28, 1.5);
  const platformMat = new THREE.MeshStandardMaterial({ color: C.wood, flatShading: true, roughness: 1, metalness: 0 });
  const strutGeo = new THREE.BoxGeometry(0.12, 1.5, 0.12);
  const strutMat = new THREE.MeshStandardMaterial({ color: C.woodDark, flatShading: true, roughness: 1, metalness: 0 });
  const poleGeo = new THREE.CylinderGeometry(0.035, 0.045, 1.7, 5);
  const poleMat = strutMat;
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.62, -0.14, 0, 0, -0.3, 0]), 3),
  );
  flagGeo.setIndex([0, 1, 2]);
  flagGeo.computeVertexNormals();
  const flagMat = new THREE.MeshStandardMaterial({ color: C.terracotta, flatShading: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const stoneGeo = new THREE.IcosahedronGeometry(0.14, 0);
  const stoneMat = new THREE.MeshStandardMaterial({ color: C.rockHi, flatShading: true, roughness: 1, metalness: 0 });
  const flameGeo = new THREE.ConeGeometry(0.15, 0.44, 6);
  const flameMat = new THREE.MeshStandardMaterial({
    color: '#B25A30',
    emissive: '#E8A94C',
    emissiveIntensity: 2.2,
    flatShading: true,
    roughness: 1,
    metalness: 0,
  });

  for (const L of world.ledges) {
    const lg = new THREE.Group();
    lg.position.copy(L.center);
    lg.rotation.y = L.theta;
    const platform = new THREE.Mesh(platformGeo, platformMat);
    lg.add(platform);
    const s1 = new THREE.Mesh(strutGeo, strutMat);
    s1.position.set(0.9, -0.6, -0.45);
    s1.rotation.x = 0.6;
    lg.add(s1);
    const s2 = new THREE.Mesh(strutGeo, strutMat);
    s2.position.set(-0.9, -0.6, -0.45);
    s2.rotation.x = 0.6;
    lg.add(s2);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(1.12, 0.98, 0.5);
    lg.add(pole);
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(1.12, 1.78, 0.5);
    lg.add(flag);
    world.flags.push({ mesh: flag, phase: L.index * 1.7, amp: 0.28 });
    // campfire: stone ring + flame
    for (let k = 0; k < 3; k++) {
      const st = new THREE.Mesh(stoneGeo, stoneMat);
      const aa = (k / 3) * TAU;
      st.position.set(-0.68 + Math.cos(aa) * 0.2, 0.2, 0.32 + Math.sin(aa) * 0.2);
      st.scale.setScalar(0.8 + (k % 2) * 0.3);
      lg.add(st);
    }
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(-0.68, 0.42, 0.32);
    lg.add(flame);
    world.flames.push({ mesh: flame, phase: L.index * 2.3 });
    g.add(lg);
  }

  // summit flag: tall pole + terracotta/cream pennant
  const summitPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 3.4, 6), poleMat);
  summitPole.position.set(0, world.summitPos.y + 1.7, 0);
  g.add(summitPole);
  const pennantGeo = new THREE.BufferGeometry();
  pennantGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1.05, -0.2, 0, 0, -0.44, 0, 0.55, -0.24, 0.01]), 3),
  );
  pennantGeo.setIndex([0, 1, 3, 0, 3, 2]);
  pennantGeo.computeVertexNormals();
  const pennant = new THREE.Mesh(pennantGeo, flagMat);
  pennant.position.set(0, world.summitPos.y + 3.3, 0);
  g.add(pennant);
  world.flags.push({ mesh: pennant, phase: 0.5, amp: 0.35 });
  const pennantCream = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: C.cream, flatShading: true, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
  pennantCream.position.set(0.02, world.summitPos.y + 2.78, 0);
  pennantCream.scale.setScalar(0.62);
  g.add(pennantCream);
  world.flags.push({ mesh: pennantCream, phase: 2.1, amp: 0.35 });

  /* trees (instanced pines below 30% altitude) */
  const treeSpots: { x: number; y: number; z: number; s: number; rot: number }[] = [];
  let guard = preset.trees * 14;
  while (treeSpots.length < preset.trees && guard-- > 0) {
    const a = rng() * TAU;
    const rr = 10 + Math.pow(rng(), 0.7) * (WORLD_R * 0.72);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const hy = heightAt(x, z);
    if (hy > MOUNTAIN_H * 0.3) continue;
    if (world.slopeAt(x, z) > 0.62) continue;
    let near = false;
    for (const h of world.holds) {
      const dx = h.pos.x - x;
      const dz = h.pos.z - z;
      if (dx * dx + dz * dz < 9) {
        near = true;
        break;
      }
    }
    if (near) continue;
    treeSpots.push({ x, y: hy, z, s: randRange(rng, 0.75, 1.5), rot: rng() * TAU });
  }
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1.7, 5);
  const trunkMat = new THREE.MeshStandardMaterial({ color: C.trunk, flatShading: true, roughness: 1, metalness: 0 });
  const coneGeo = new THREE.ConeGeometry(1, 2.1, 6);
  const coneMat = new THREE.MeshStandardMaterial({ color: C.forest, flatShading: true, roughness: 1, metalness: 0 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treeSpots.length);
  const coneMeshA = new THREE.InstancedMesh(coneGeo, coneMat, treeSpots.length);
  const coneMeshB = new THREE.InstancedMesh(coneGeo, coneMat, treeSpots.length);
  const eul = new THREE.Euler();
  treeSpots.forEach((t, i) => {
    eul.set(0, t.rot, 0);
    q.setFromEuler(eul);
    m4.compose(new THREE.Vector3(t.x, t.y + 0.8 * t.s, t.z), q, sv.set(t.s, t.s, t.s));
    trunkMesh.setMatrixAt(i, m4);
    m4.compose(new THREE.Vector3(t.x, t.y + (1.7 + 1.0) * t.s, t.z), q, sv.set(t.s * 1.05, t.s, t.s * 1.05));
    coneMeshA.setMatrixAt(i, m4);
    m4.compose(new THREE.Vector3(t.x, t.y + (1.7 + 2.2) * t.s, t.z), q, sv.set(t.s * 0.7, t.s * 0.85, t.s * 0.7));
    coneMeshB.setMatrixAt(i, m4);
    world.colliders.push({ x: t.x, y: t.y + 1, z: t.z, r: 0.5 * t.s });
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  coneMeshA.instanceMatrix.needsUpdate = true;
  coneMeshB.instanceMatrix.needsUpdate = true;
  g.add(trunkMesh, coneMeshA, coneMeshB);

  onProgress({ label: '种下松树…', frac: 0.76 });
  await nextChunk();

  /* rocks (instanced, below snow line) */
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: C.rockMid, flatShading: true, roughness: 1, metalness: 0 });
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, preset.rocks);
  let placed = 0;
  guard = preset.rocks * 14;
  while (placed < preset.rocks && guard-- > 0) {
    const a = rng() * TAU;
    const rr = 6 + Math.pow(rng(), 0.8) * (WORLD_R * 0.66);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const hy = heightAt(x, z);
    if (hy > MOUNTAIN_H * 0.68) continue;
    if (world.slopeAt(x, z) > 1.5) continue;
    let near = false;
    for (const h of world.holds) {
      const dx = h.pos.x - x;
      const dz = h.pos.z - z;
      if (dx * dx + dz * dz < 4.6) {
        near = true;
        break;
      }
    }
    if (near) continue;
    const s = randRange(rng, 0.35, 1.5);
    eul.set(rng() * 0.6, rng() * TAU, rng() * 0.6);
    q.setFromEuler(eul);
    m4.compose(new THREE.Vector3(x, hy + s * 0.25, z), q, sv.set(s, s * randRange(rng, 0.55, 0.85), s * randRange(rng, 0.7, 1)));
    rockMesh.setMatrixAt(placed, m4);
    if (s > 0.8) world.colliders.push({ x, y: hy + s * 0.3, z, r: s * 0.8 });
    placed++;
  }
  rockMesh.count = placed;
  rockMesh.instanceMatrix.needsUpdate = true;
  g.add(rockMesh);

  /* clouds (instanced merged icospheres, slow drift) */
  const cloudGeo = new THREE.IcosahedronGeometry(1, 1);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: '#FBF7EE',
    flatShading: true,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.94,
  });
  const puffTotal = preset.cloudClusters * 5;
  const cloudMesh = new THREE.InstancedMesh(cloudGeo, cloudMat, puffTotal);
  let ci = 0;
  for (let cIdx = 0; cIdx < preset.cloudClusters; cIdx++) {
    const a = rng() * TAU;
    const rr = randRange(rng, 125, 215);
    const cx = Math.cos(a) * rr;
    const cz = Math.sin(a) * rr;
    const cy = randRange(rng, 60, 178);
    const puffs = 4 + Math.floor(rng() * 2);
    for (let p = 0; p < puffs && ci < puffTotal; p++) {
      const s = randRange(rng, 5, 13);
      eul.set(0, rng() * TAU, 0);
      q.setFromEuler(eul);
      m4.compose(
        new THREE.Vector3(cx + randRange(rng, -9, 9), cy + randRange(rng, -2.5, 2.5), cz + randRange(rng, -9, 9)),
        q,
        sv.set(s * randRange(rng, 1, 1.6), s * 0.55, s),
      );
      cloudMesh.setMatrixAt(ci++, m4);
    }
  }
  cloudMesh.count = ci;
  cloudMesh.instanceMatrix.needsUpdate = true;
  world.cloudGroup.add(cloudMesh);

  /* circling birds */
  const birdBodyGeo = new THREE.BoxGeometry(0.5, 0.14, 0.2);
  const birdWingGeo = new THREE.BoxGeometry(0.34, 0.04, 0.72);
  const birdMat = new THREE.MeshStandardMaterial({ color: '#5A4A38', flatShading: true, roughness: 1, metalness: 0 });
  for (let b = 0; b < preset.birds; b++) {
    const bg = new THREE.Group();
    const body = new THREE.Mesh(birdBodyGeo, birdMat);
    bg.add(body);
    const wingL = new THREE.Mesh(birdWingGeo, birdMat);
    wingL.position.set(0, 0.05, 0.4);
    bg.add(wingL);
    const wingR = new THREE.Mesh(birdWingGeo, birdMat);
    wingR.position.set(0, 0.05, -0.4);
    bg.add(wingR);
    const bird = {
      group: bg,
      wingL,
      wingR,
      r: randRange(rng, 34, 62),
      h: randRange(rng, 95, 135),
      speed: randRange(rng, 0.12, 0.22) * (b % 2 === 0 ? 1 : -1),
      a: rng() * TAU,
      phase: rng() * TAU,
    };
    world.birds.push(bird);
    g.add(bg);
  }

  onProgress({ label: '布置岩点…', frac: 0.9 });
  await nextChunk();

  console.log(`[gen] seed=${seed} verts=${vertTotal} holds=${world.holds.length}`);
  return world;
}
