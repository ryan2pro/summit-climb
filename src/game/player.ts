/**
 * Player — kinematic capsule controller (design.md §11.2) + stamina (§11.3).
 *
 *  - capsule r0.35 h1.7, eye 1.55m; gravity 22, accel 40, friction 10,
 *    max walk 4.8 m/s, air control ×0.45, jump 7.2 m/s (fixed 120Hz substeps)
 *  - collision: analytic heightfield + ledge platforms + sphere colliders
 *    (push-out, owned by World.collide). Slopes > ~49° are unwalkable —
 *    that's what the hold route is for.
 *  - GRAB (PEAK-style universal climbing): raycast 2.4m at holds/ledges,
 *    else a 2.6m terrain probe — ANY steep surface (normal.y < 0.6) is
 *    grabbable → HANG: snap to the wall, gravity off, WASD traverses the
 *    wall plane (2.2 m/s, tethered 1.45m to the anchor), Space = wall jump
 *    (push off along normal + up, 12 stamina), Shift = lunge (quick +2.2m
 *    boost along the wall, 10 stamina), release = drop. Moving up over a
 *    ledge rim mantles onto it.
 *  - stamina: 100 max; bare wall hang 2.5/s idle, 6/s moving; hanging on a
 *    hold/ledge (rest spot) 0.5/s; ground sprint (Shift) ×1.5 speed, 5/s;
 *    ground jump 6; regen 25/s on ground (0.6s delay), 40/s on rest
 *    ledges; empty while hanging → SLIDE: ~0.8s scraping down the wall,
 *    then release into a fall + 力竭 1.2s grab lockout.
 *  - helping hand (multiplayer): startPull lerps the player toward a
 *    teammate over ~0.6s; nudgeToward shifts the helper ~0.3m.
 *  - fall > 18m from apex (or 25m below checkpoint) → checkpoint rescue.
 *  - summit: grounded within 4m of the flag pole.
 */

import * as THREE from 'three';
import type { World, GrabHit, Ledge } from './world';

export type MoveState = 'ground' | 'air' | 'hang' | 'slide';

export interface FrameInput {
  /** strafe right −1..1 */
  moveX: number;
  /** forward −1..1 */
  moveY: number;
  /** edge-triggered jump */
  jump: boolean;
  /** edge-triggered lunge (Shift while hanging / mobile 跳 while hanging) */
  lunge: boolean;
  /** sprint held (Shift on the ground) */
  sprint: boolean;
  /** grab held */
  grab: boolean;
  /** helping hand held (RMB / mobile 拉手) — resolved by the game page */
  help: boolean;
}

export interface PlayerEvents {
  onGrab: (hit: GrabHit) => void;
  onJump: () => void;
  onWallJump: () => void;
  onLunge: () => void;
  onLand: (hard: boolean) => void;
  onCheckpoint: (ledge: Ledge) => void;
  onSummit: () => void;
  onRespawn: (auto: boolean) => void;
  onExhausted: () => void;
  onFallPrompt: () => void;
}

export const STAM = {
  max: 100,
  hangIdle: 2.5,
  hangMove: 6,
  /** hanging on a hold/ledge = rest spot (fixed gear, near-zero drain) */
  restDrain: 0.5,
  wallJump: 12,
  lunge: 10,
  groundJump: 6,
  sprint: 5,
  regenGround: 25,
  regenLedge: 40,
  regenDelay: 0.6,
  low: 25,
} as const;

const GRAVITY = 22;
const ACCEL = 40;
const FRICTION = 10;
const MAX_WALK = 4.8;
const AIR_CTRL = 0.45;
const JUMP_V = 7.2;
const EYE = 1.55;
const BODY_R = 0.4;
const GRAB_RANGE = 2.4;
/** reach of the bare-wall terrain probe (PEAK: grab near any steep face) */
const WALL_GRAB_RANGE = 2.6;
const TRAVERSE = 2.2;
const TETHER = 1.45;
const FALL_RESCUE = 18;
const CP_FALL = 25;
/** exhaustion slide: scrape down the wall ~0.8s before letting go */
const SLIDE_TIME = 0.8;
const SLIDE_SPEED = 6;
/** lunge: +2.2m along the wall over 0.25s */
const LUNGE_TIME = 0.25;
const LUNGE_RISE = 2.2;
/** ground sprint: ×1.5 top speed */
const SPRINT_MULT = 1.5;
/** movement/jump slope limit — terraced wall bands (~1.03) stay unwalkable */
const WALKABLE_SLOPE = 0.95;
/** mantle accepts slightly steeper landings (summit rim ~1.0–1.15) */
const MANTLE_MAX_SLOPE = 1.15;

export class Player {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  state: MoveState = 'ground';
  stamina: number = STAM.max;
  checkpointIndex = 0;
  falls = 0;
  summitReached = false;

  /** hang attachment (valid when state==='hang') */
  readonly hangNormal = new THREE.Vector3(0, 0, 1);
  private anchor = new THREE.Vector3();
  private sx = 0;
  private sz = 0;

  private grounded = false;
  private coyote = 0;
  private grabCooldownUntil = 0;
  private exhaustedUntil = -1;
  private lastDrainT = -10;
  private fallApex = 0;
  private airSince = 0;
  private fallPrompted = false;
  private bobPhase = 0;
  private bobY = 0;
  private dip = 0;
  private dipVel = 0;
  private world: World;
  private events: PlayerEvents;
  private tmpG = { x: 0, z: 0 };
  private tmpV = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private onLedge: Ledge | null = null;
  private groundSlope = 0;
  /** hang on a hold/ledge (rest spot) vs bare wall */
  private restSpot = false;
  /** exhaustion slide / lunge / pull timers (-1 = inactive) */
  private slideUntil = -1;
  private lungeUntil = -1;
  private pullStart = -1;
  private pullDur = 0.6;
  private pullFrom = new THREE.Vector3();
  private pullTo = new THREE.Vector3();
  /** HUD canGrab probe (updated each substep while playing) */
  canGrab = false;
  private lastGrabProbe: GrabHit | null = null;

  constructor(world: World, events: PlayerEvents) {
    this.world = world;
    this.events = events;
  }

  spawnAt(index: number, faceYaw?: number): void {
    const L = this.world.ledges[Math.min(index, this.world.ledges.length - 1)];
    this.checkpointIndex = L.index;
    this.pos.copy(L.spawn);
    this.vel.set(0, 0, 0);
    this.state = 'ground';
    this.grounded = true;
    this.onLedge = L;
    this.stamina = STAM.max;
    this.summitReached = false;
    this.falls = 0;
    this.exhaustedUntil = -1;
    this.grabCooldownUntil = 0;
    this.slideUntil = -1;
    this.lungeUntil = -1;
    this.pullStart = -1;
    if (faceYaw !== undefined) this.yaw = faceYaw;
    this.pitch = 0;
  }

  /** yaw to face the next hold above a ledge (spawn orientation helper). */
  yawTowardRoute(fromLedge: number): number {
    const L = this.world.ledges[Math.min(fromLedge, this.world.ledges.length - 1)];
    const next = this.world.holds[Math.min(L.holdIndex + 1, this.world.holds.length - 1)];
    const dx = next.pos.x - L.spawn.x;
    const dz = next.pos.z - L.spawn.z;
    return Math.atan2(-dx, -dz);
  }

  get eyeY(): number {
    return this.pos.y + EYE + this.bobY + this.dip;
  }

  getEye(out: THREE.Vector3): THREE.Vector3 {
    out.set(this.pos.x, this.eyeY, this.pos.z);
    if (this.state === 'hang') out.addScaledVector(this.hangNormal, -0.12);
    return out;
  }

  getLookDir(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  get exhausted(): boolean {
    return this.exhaustedUntil > 0 && this._now < this.exhaustedUntil;
  }

  private _now = 0;

  /** net bitflags: 1=moving 2=hanging 4=exhausted 8=falling */
  get flags(): number {
    let f = 0;
    if (this.horizontalSpeed > 0.5 || (this.state === 'hang' && this._moving)) f |= 1;
    if (this.state === 'hang') f |= 2;
    if (this.exhausted) f |= 4;
    if (this.state === 'air' && this.vel.y < -3) f |= 8;
    return f;
  }

  private _moving = false;

  private startFall(): void {
    this.fallApex = this.pos.y;
    this.airSince = this._now;
    this.fallPrompted = false;
  }

  private drain(amount: number): void {
    this.stamina = Math.max(0, this.stamina - amount);
    this.lastDrainT = this._now;
  }

  /** Manual (R / pause menu) or automatic rescue → checkpoint respawn. */
  respawn(auto: boolean): void {
    const L = this.world.ledges[Math.min(this.checkpointIndex, this.world.ledges.length - 1)];
    this.pos.copy(L.spawn);
    this.vel.set(0, 0, 0);
    this.state = 'ground';
    this.grounded = true;
    this.onLedge = L;
    this.stamina = 60;
    this.falls += 1;
    this.grabCooldownUntil = this._now + 0.3;
    this.slideUntil = -1;
    this.lungeUntil = -1;
    this.pullStart = -1;
    this.dip = 0;
    this.dipVel = 0;
    this.events.onRespawn(auto);
  }

  /** true while being pulled up by a teammate's helping hand */
  get pulling(): boolean {
    return this.pullStart >= 0 && this._now < this.pullStart + this.pullDur;
  }

  /**
   * Helping hand (target side): let go and glide to `dest` over `dur`
   * seconds — the target client stays the authority of its own position.
   */
  startPull(dest: THREE.Vector3, dur = 0.6): void {
    if (this.state === 'hang' || this.state === 'slide') this.state = 'air';
    this.vel.set(0, 0, 0);
    this.pullFrom.copy(this.pos);
    this.pullTo.copy(dest);
    this.pullStart = this._now;
    this.pullDur = dur;
  }

  /** Helping hand (helper side): the pull tugs you ~0.3m toward them. */
  nudgeToward(target: THREE.Vector3, dist = 0.3): void {
    const d = this.tmpV.copy(target).sub(this.pos);
    const l = d.length();
    if (l < 1e-4) return;
    d.multiplyScalar(Math.min(dist, l) / l);
    if (this.state === 'hang' || this.state === 'slide') {
      this.sx += d.x;
      this.sz += d.z;
      this.anchor.add(d);
      this.positionOnWall();
    } else {
      this.pos.add(d);
    }
  }

  /** Fixed 120Hz substep. `now` = accumulated sim seconds (pause-safe). */
  update(dt: number, input: FrameInput, now: number): void {
    this._now = now;
    // being pulled up by a teammate: smooth lerp, physics suspended
    if (this.pulling) {
      const t = (now - this.pullStart) / this.pullDur;
      const e = t * t * (3 - 2 * t);
      this.pos.lerpVectors(this.pullFrom, this.pullTo, e);
      if (t >= 1 - 1e-6 || now >= this.pullStart + this.pullDur) {
        this.pos.copy(this.pullTo);
        this.pullStart = -1;
        this.startFall();
      }
      return;
    }
    if (this.state === 'hang') this.updateHang(dt, input);
    else if (this.state === 'slide') this.updateSlide(dt);
    else this.updateWalk(dt, input);

    // grab probe (every substep while not hanging): holds/ledges first,
    // then the universal steep-wall probe (PEAK: climb any steep face)
    if (this.state !== 'hang' && this.state !== 'slide') {
      if (input.grab && now >= this.grabCooldownUntil && now >= this.exhaustedUntil) {
        const hit = this.probeGrab();
        this.lastGrabProbe = hit;
        this.canGrab = hit !== null;
        if (hit) this.enterHang(hit);
      } else if ((this._probeAcc += dt) > 0.1) {
        this._probeAcc = 0;
        this.lastGrabProbe = this.probeGrab();
        this.canGrab = this.lastGrabProbe !== null && now >= this.exhaustedUntil;
      }
    } else {
      this.canGrab = false;
    }

    // stamina regen (after 0.6s since last drain)
    if (now - this.lastDrainT > STAM.regenDelay && this.stamina < STAM.max) {
      const rate = this.onLedge ? STAM.regenLedge : this.grounded ? STAM.regenGround : 0;
      this.stamina = Math.min(STAM.max, this.stamina + rate * dt);
    }

    // head bob + land dip springs
    if (this.grounded && this.horizontalSpeed > 0.4) {
      this.bobPhase += dt * this.horizontalSpeed * 1.65;
      this.bobY = Math.sin(this.bobPhase) * 0.04;
    } else {
      this.bobY *= Math.max(0, 1 - dt * 6);
    }
    this.dip += this.dipVel * dt;
    this.dipVel += (-this.dip * 90 - this.dipVel * 12) * dt;
  }

  private _probeAcc = 0;

  /** holds/ledges (rest spots) take priority over the bare-wall probe */
  private probeGrab(): GrabHit | null {
    this.getEye(this.tmpV);
    this.getLookDir(this.tmpC);
    return (
      this.world.grabRaycast(this.tmpV, this.tmpC, GRAB_RANGE) ??
      this.world.wallProbe(this.tmpV, this.tmpC, WALL_GRAB_RANGE)
    );
  }

  private enterHang(hit: GrabHit): void {
    this.state = 'hang';
    this.restSpot = hit.kind !== 'wall';
    this.slideUntil = -1;
    this.lungeUntil = -1;
    this.vel.set(0, 0, 0);
    this.anchor.copy(hit.point);
    if (hit.kind === 'ledge') {
      // ledge grabs anchor slightly toward the wall so traverse starts sane
      const nh = this.tmpV.set(hit.normal.x, 0, hit.normal.z);
      if (nh.lengthSq() > 1e-6) this.anchor.addScaledVector(nh.normalize(), -0.4);
    }
    this.sx = this.anchor.x;
    this.sz = this.anchor.z;
    this.hangNormal.copy(hit.normal);
    this.grounded = false;
    this.positionOnWall();
    this.events.onGrab(hit);
  }

  private releaseGrab(cooldown: number): void {
    this.state = 'air';
    this.grabCooldownUntil = this._now + cooldown;
    this.startFall();
  }

  /** place the body so hands rest on the wall contact (sx, sz) */
  private positionOnWall(): void {
    const hy = this.world.heightAt(this.sx, this.sz);
    this.world.normalAt(this.sx, this.sz, this.hangNormal);
    // eye = hands + normal*0.5 - 0.35 up; feet = eye - 1.55
    this.pos.set(
      this.sx + this.hangNormal.x * 0.5,
      hy - 0.35 - EYE + this.hangNormal.y * 0.5,
      this.sz + this.hangNormal.z * 0.5,
    );
  }

  private updateHang(dt: number, input: FrameInput): void {
    const moving = Math.abs(input.moveX) > 0.12 || Math.abs(input.moveY) > 0.12;
    this._moving = moving;
    // rest spots (holds/ledges = fixed gear) barely drain; bare wall is work
    this.drain((this.restSpot ? STAM.restDrain : moving ? STAM.hangMove : STAM.hangIdle) * dt);

    if (this.stamina <= 0) {
      // PEAK: running out mid-climb = slide down the wall, THEN let go
      this.startSlide();
      return;
    }
    if (!input.grab) {
      this.releaseGrab(0.25);
      return;
    }
    if (input.lunge && this._now >= this.lungeUntil) {
      // lunge: quick vertical boost along the wall, costs a chunk of stamina
      this.stamina = Math.max(0, this.stamina - STAM.lunge);
      this.lastDrainT = this._now;
      this.lungeUntil = this._now + LUNGE_TIME;
      this.events.onLunge();
    }
    if (this._now < this.lungeUntil) {
      // climb boost: ride the fall line up, re-anchor so the tether keeps up
      const g = this.world.gradientAt(this.sx, this.sz, this.tmpG);
      const m = Math.hypot(g.x, g.z);
      if (m > 1e-4) {
        const slope = Math.max(1.2, m);
        const climb = ((LUNGE_RISE / LUNGE_TIME) * dt) / slope;
        this.sx += (g.x / m) * climb;
        this.sz += (g.z / m) * climb;
        this.anchor.set(this.sx, this.world.heightAt(this.sx, this.sz), this.sz);
        this.positionOnWall();
      }
    }
    if (input.jump) {
      // wall jump: push off along the normal + up
      this.stamina = Math.max(0, this.stamina - STAM.wallJump);
      this.lastDrainT = this._now;
      const nh = this.tmpV.set(this.hangNormal.x, 0, this.hangNormal.z).normalize();
      this.vel.set(nh.x * 4.2, 6.2, nh.z * 4.2);
      this.state = 'air';
      this.grabCooldownUntil = this._now + 0.3;
      this.startFall();
      this.events.onWallJump();
      return;
    }

    if (moving) {
      const g = this.world.gradientAt(this.sx, this.sz, this.tmpG);
      const m = Math.hypot(g.x, g.z);
      const slope = Math.max(1.2, m);
      let ux = 0;
      let uz = 0;
      if (m > 1e-4) {
        ux = g.x / m;
        uz = g.z / m;
      }
      // tangent along the contour, signed by camera-right
      let tx = -uz;
      let tz = ux;
      const camRx = Math.cos(this.yaw);
      const camRz = -Math.sin(this.yaw);
      if (tx * camRx + tz * camRz < 0) {
        tx = -tx;
        tz = -tz;
      }
      const climb = (input.moveY * TRAVERSE * dt) / slope;
      const side = input.moveX * TRAVERSE * dt;
      const nsx = this.sx + ux * climb + tx * side;
      const nsz = this.sz + uz * climb + tz * side;
      // tether: hands can stray at most TETHER from the held point
      const hy = this.world.heightAt(nsx, nsz);
      const dx = nsx - this.anchor.x;
      const dy = hy - this.anchor.y;
      const dz = nsz - this.anchor.z;
      if (dx * dx + dy * dy + dz * dz <= TETHER * TETHER) {
        this.sx = nsx;
        this.sz = nsz;
      }
      this.positionOnWall();

      // mantle: moving up over a rim onto ground. Probe outward (rest
      // ledges extend toward the player) then inward (summit plateau rim);
      // only walkable ground (or ledge tops) is a valid landing.
      if (input.moveY > 0.3) {
        const handsY = this.world.heightAt(this.sx, this.sz);
        const nl = Math.hypot(this.hangNormal.x, this.hangNormal.z) || 1;
        const ox = (this.hangNormal.x / nl) * 0.6;
        const oz = (this.hangNormal.z / nl) * 0.6;
        for (const s of [1, -1]) {
          const px = this.sx + ox * s;
          const pz = this.sz + oz * s;
          const g2 = this.world.groundAt(px, pz, handsY + 1.3);
          const rise = g2.y - handsY;
          if (rise > -0.35 && rise < 1.15 && (g2.ledge !== null || this.world.slopeAt(px, pz) <= MANTLE_MAX_SLOPE)) {
            this.state = 'ground';
            this.grounded = true;
            this.pos.set(px, g2.y, pz);
            this.vel.set(0, 0, 0);
            this.grabCooldownUntil = this._now + 0.2;
            break;
          }
        }
      }
    }
  }

  private startSlide(): void {
    this.state = 'slide';
    this._moving = false;
    this.slideUntil = this._now + SLIDE_TIME;
    this.vel.set(0, 0, 0);
    this.events.onExhausted();
  }

  /** SLIDE: scrape rapidly down the wall fall line, then release + lockout */
  private updateSlide(dt: number): void {
    const g = this.world.gradientAt(this.sx, this.sz, this.tmpG);
    const m = Math.hypot(g.x, g.z);
    if (m > 1e-4) {
      const slope = Math.max(1.2, m);
      const ds = (SLIDE_SPEED * dt) / slope;
      this.sx -= (g.x / m) * ds;
      this.sz -= (g.z / m) * ds;
      this.anchor.set(this.sx, this.world.heightAt(this.sx, this.sz), this.sz);
    }
    this.positionOnWall();
    if (this._now >= this.slideUntil) {
      this.releaseGrab(0.4);
      this.exhaustedUntil = this._now + 1.2;
    }
  }

  private updateWalk(dt: number, input: FrameInput): void {
    const wasGrounded = this.grounded;
    // camera-relative wish direction
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    let wx = -sy * input.moveY + cy * input.moveX;
    let wz = -cy * input.moveY - sy * input.moveX;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    this._moving = wl > 0.12;

    // sprint (Shift on the ground): ×1.5 top speed, drains 5 stamina/s
    const sprinting = input.sprint && this.grounded && wl > 0.12 && this.stamina > 0;
    const maxWalk = sprinting ? MAX_WALK * SPRINT_MULT : MAX_WALK;
    if (sprinting) this.drain(STAM.sprint * dt);

    // steep walls are unwalkable: strip the uphill component, no footing
    // for jumps, and a gentle downhill slide (ledge platforms excepted)
    this.groundSlope = 0;
    if (this.grounded && !this.onLedge) {
      const g = this.world.gradientAt(this.pos.x, this.pos.z, this.tmpG);
      const m = Math.hypot(g.x, g.z);
      this.groundSlope = m;
      if (m > WALKABLE_SLOPE) {
        const ux = g.x / m;
        const uz = g.z / m;
        const comp = wx * ux + wz * uz;
        if (comp > 0) {
          wx -= ux * comp;
          wz -= uz * comp;
        }
        const vcomp = this.vel.x * ux + this.vel.z * uz;
        if (vcomp > 0) {
          const k = Math.min(1, 10 * dt);
          this.vel.x -= ux * vcomp * k;
          this.vel.z -= uz * vcomp * k;
        }
        // no footing on steep faces — slide back down
        this.vel.x -= ux * 14 * dt;
        this.vel.z -= uz * 14 * dt;
      }
    }

    // friction (ground) + quake-style accelerate
    if (this.grounded) {
      const speed = this.horizontalSpeed;
      if (speed > 0) {
        const drop = speed * FRICTION * dt;
        const scale = Math.max(0, speed - drop) / speed;
        this.vel.x *= scale;
        this.vel.z *= scale;
      }
    }
    if (wl > 0.01) {
      const accel = this.grounded ? ACCEL : ACCEL * AIR_CTRL;
      const current = this.vel.x * wx + this.vel.z * wz;
      const add = maxWalk - current;
      if (add > 0) {
        const acc = Math.min(accel * dt * maxWalk, add);
        this.vel.x += wx * acc;
        this.vel.z += wz * acc;
      }
    }

    // gravity
    this.vel.y = this.grounded ? Math.max(this.vel.y - GRAVITY * dt, -1) : this.vel.y - GRAVITY * dt;

    // jump / coyote
    if (this.grounded) this.coyote = 0.12;
    else this.coyote = Math.max(0, this.coyote - dt);
    if (input.jump && this.coyote > 0 && this.groundSlope <= WALKABLE_SLOPE) {
      this.vel.y = JUMP_V;
      this.grounded = false;
      this.state = 'air';
      this.coyote = 0;
      this.drain(STAM.groundJump);
      this.startFall();
      this.events.onJump();
    }

    // integrate horizontal with step/wall resolution
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    if (this.grounded) {
      let g = this.world.groundAt(nx, nz, this.pos.y);
      if (g.y - this.pos.y > 0.55) {
        // wall: try sliding on each axis
        const gx = this.world.groundAt(nx, this.pos.z, this.pos.y);
        const gz = this.world.groundAt(this.pos.x, nz, this.pos.y);
        if (gx.y - this.pos.y <= 0.55) {
          this.pos.x = nx;
          g = gx;
        } else if (gz.y - this.pos.y <= 0.55) {
          this.pos.z = nz;
          g = gz;
        } else {
          g = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y);
        }
      } else {
        this.pos.x = nx;
        this.pos.z = nz;
      }
      const drop = g.y - this.pos.y;
      if (drop < -0.45) {
        this.grounded = false;
        this.state = 'air';
        this.startFall();
        this.pos.y += this.vel.y * dt;
      } else {
        this.pos.y = g.y;
        this.vel.y = 0;
        this.onLedge = g.ledge;
      }
    } else {
      this.pos.x = nx;
      this.pos.z = nz;
      this.pos.y += this.vel.y * dt;
      const g = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y);
      if (this.pos.y <= g.y) {
        const hard = this.vel.y < -13;
        const quiet = this._now - this.airSince < 0.12; // skip step-down micro-lands
        this.pos.y = g.y;
        this.vel.y = 0;
        this.grounded = true;
        this.state = 'ground';
        this.onLedge = g.ledge;
        if (!quiet) {
          this.dipVel = hard ? -0.55 : -0.28;
          this.events.onLand(hard);
        }
      }
    }
    if (!this.grounded && wasGrounded) this.onLedge = null;

    // prop/hold sphere push-out (horizontal)
    this.tmpC.set(this.pos.x, this.pos.y + 0.6, this.pos.z);
    this.world.collide(this.tmpC, BODY_R);
    this.pos.x = this.tmpC.x;
    this.pos.z = this.tmpC.z;

    if (!this.grounded) {
      // fall tracking + rescue
      if (this.pos.y > this.fallApex) this.fallApex = this.pos.y;
      const cp = this.world.ledges[Math.min(this.checkpointIndex, this.world.ledges.length - 1)];
      if (this.fallApex - this.pos.y > FALL_RESCUE || this.pos.y < cp.topY - CP_FALL) {
        this.respawn(true);
        return;
      }
      if (!this.fallPrompted && this._now - this.airSince > 3 && this.vel.y < -2) {
        this.fallPrompted = true;
        this.events.onFallPrompt();
      }
    }

    // checkpoint on rest ledges
    if (this.grounded && this.onLedge && this.onLedge.index > this.checkpointIndex) {
      this.checkpointIndex = this.onLedge.index;
      this.events.onCheckpoint(this.onLedge);
    }

    // summit
    if (!this.summitReached && this.grounded) {
      const dx = this.pos.x - this.world.summitPos.x;
      const dz = this.pos.z - this.world.summitPos.z;
      if (dx * dx + dz * dz < this.world.summitRadius * this.world.summitRadius) {
        this.summitReached = true;
        this.events.onSummit();
      }
    }
  }
}
