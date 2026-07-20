/**
 * Player — kinematic capsule controller (design.md §11.2) + stamina (§11.3).
 *
 *  - capsule r0.35 h1.7, eye 1.55m; gravity 22, accel 40, friction 10,
 *    max walk 4.8 m/s, air control ×0.45, jump 7.2 m/s (fixed 120Hz substeps)
 *  - collision: analytic heightfield + ledge platforms + sphere colliders
 *    (push-out, owned by World.collide). Slopes > ~49° are unwalkable —
 *    that's what the hold route is for.
 *  - GRAB: raycast 2.4m from camera center → HANG: snap to hold, gravity
 *    off, WASD traverses the wall plane (2.2 m/s, tethered 1.45m to the
 *    hold), jump = wall jump (push off along normal + up), release = drop.
 *    Moving up over a ledge rim mantles onto it.
 *  - stamina: 100 max; hang 2.5/s idle, 6/s moving; wall jump 12; ground
 *    jump 6; regen 25/s on ground (0.6s delay), 40/s on rest ledges; empty
 *    while hanging → forced release + 力竭 1.2s grab lockout.
 *  - fall > 18m from apex (or 25m below checkpoint) → checkpoint rescue.
 *  - summit: grounded within 4m of the flag pole.
 */

import * as THREE from 'three';
import type { World, GrabHit, Ledge } from './world';

export type MoveState = 'ground' | 'air' | 'hang';

export interface FrameInput {
  /** strafe right −1..1 */
  moveX: number;
  /** forward −1..1 */
  moveY: number;
  /** edge-triggered jump */
  jump: boolean;
  /** grab held */
  grab: boolean;
}

export interface PlayerEvents {
  onGrab: (hit: GrabHit) => void;
  onJump: () => void;
  onWallJump: () => void;
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
  wallJump: 12,
  groundJump: 6,
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
const TRAVERSE = 2.2;
const TETHER = 1.45;
const FALL_RESCUE = 18;
const CP_FALL = 25;
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
    this.dip = 0;
    this.dipVel = 0;
    this.events.onRespawn(auto);
  }

  /** Fixed 120Hz substep. `now` = accumulated sim seconds (pause-safe). */
  update(dt: number, input: FrameInput, now: number): void {
    this._now = now;
    if (this.state === 'hang') this.updateHang(dt, input);
    else this.updateWalk(dt, input);

    // grab probe (every substep while not hanging)
    if (this.state !== 'hang') {
      if (input.grab && now >= this.grabCooldownUntil && now >= this.exhaustedUntil) {
        this.getEye(this.tmpV);
        this.getLookDir(this.tmpC);
        const hit = this.world.grabRaycast(this.tmpV, this.tmpC, GRAB_RANGE);
        this.lastGrabProbe = hit;
        this.canGrab = hit !== null;
        if (hit) this.enterHang(hit);
      } else if ((this._probeAcc += dt) > 0.1) {
        this._probeAcc = 0;
        this.getEye(this.tmpV);
        this.getLookDir(this.tmpC);
        this.lastGrabProbe = this.world.grabRaycast(this.tmpV, this.tmpC, GRAB_RANGE);
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

  private enterHang(hit: GrabHit): void {
    this.state = 'hang';
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
    this.drain((moving ? STAM.hangMove : STAM.hangIdle) * dt);

    if (this.stamina <= 0) {
      this.releaseGrab(0.4);
      this.exhaustedUntil = this._now + 1.2;
      this.events.onExhausted();
      return;
    }
    if (!input.grab) {
      this.releaseGrab(0.25);
      return;
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
      const add = MAX_WALK - current;
      if (add > 0) {
        const acc = Math.min(accel * dt * MAX_WALK, add);
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
