/**
 * Input — unified PC keyboard/mouse (pointer-lock) + mobile touch controls
 * (design.md §11.4).
 *
 *  PC: WASD/arrows move · pointer-lock mouse look · Space jump · hold E or
 *      LMB grab · Shift sprint on the ground / lunge while hanging ·
 *      hold RMB helping hand · R respawn · Tab players · Esc pause.
 *  Mobile: left-half floating joystick (10% deadzone, radial clamp) ·
 *      right-half drag look · optional gyroscope look (yaw from alpha,
 *      pitch from beta/gamma per screen orientation, fused with drag as
 *      offsets; iOS requestPermission flow) · 抓取 hold-to-grab + 跳 buttons
 *      (while hanging, 跳 = lunge boost) + 拉手 helping-hand button wired
 *      via setTouchGrab/pressJump/setTouchHelp. `hanging` is fed back by
 *      the game loop so mobile 跳 can mean jump-vs-lunge.
 */

import type { FrameInput } from './player';

export interface LookDelta {
  dx: number;
  dy: number;
}

export interface JoystickState {
  active: boolean;
  id: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  lastActive: number;
}

const JOY_RADIUS = 56;
const DEADZONE = 0.1;
const TOUCH_LOOK_SCALE = 2.4;

interface DeviceOrientationEventWithPermission extends DeviceOrientationEvent {
  requestPermission?: () => Promise<string>;
}

export class InputManager {
  readonly isMobile: boolean;
  pointerLocked = false;
  tabHeld = false;
  gyroEnabled = false;
  gyroActive = false;
  /** fed back by the game loop each rAF (mobile 跳 = jump vs lunge) */
  hanging = false;

  readonly joystick: JoystickState = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0, lastActive: 0 };

  onPauseRequest: (() => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  onFirstInteract: (() => void) | null = null;

  private canvas: HTMLCanvasElement;
  private keys = new Set<string>();
  private lookDX = 0;
  private lookDY = 0;
  private gyroDX = 0;
  private gyroDY = 0;
  private gyroLastA: number | null = null;
  private gyroLastB: number | null = null;
  private gyroLastG: number | null = null;
  private jumpEdge = false;
  private lungeEdge = false;
  private respawnEdge = false;
  private touchGrab = false;
  private mouseGrab = false;
  private rmbHeld = false;
  private touchHelp = false;
  private lookTouchId = -1;
  private lookLastX = 0;
  private lookLastY = 0;
  private interacted = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, isMobile: boolean) {
    this.canvas = canvas;
    this.isMobile = isMobile;
  }

  /* ------------------------------ listeners ------------------------------ */

  private markInteract = () => {
    if (this.interacted) return;
    this.interacted = true;
    this.onFirstInteract?.();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.markInteract();
    const c = e.code;
    if (c === 'Space') {
      this.jumpEdge = true;
      e.preventDefault();
      return;
    }
    if (c === 'Tab') {
      this.tabHeld = true;
      e.preventDefault();
      return;
    }
    if (c === 'KeyR') {
      this.respawnEdge = true;
      return;
    }
    if (c === 'ShiftLeft' || c === 'ShiftRight') {
      this.lungeEdge = true; // consumed as lunge only while hanging
      this.keys.add(c);
      return;
    }
    if (c === 'Escape') {
      if (!this.pointerLocked) this.onPauseRequest?.();
      return;
    }
    this.keys.add(c);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Tab') {
      this.tabHeld = false;
      e.preventDefault();
      return;
    }
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.mouseGrab = false;
    this.rmbHeld = false;
    this.tabHeld = false;
  };

  private onMouseDown = (e: MouseEvent) => {
    this.markInteract();
    if (e.button === 2) {
      // RMB: helping hand (multiplayer) — hold to channel a pull
      if (this.pointerLocked) this.rmbHeld = true;
      return;
    }
    if (e.button !== 0) return;
    if (!this.isMobile && !this.pointerLocked) {
      this.requestLock();
      return;
    }
    if (this.pointerLocked) this.mouseGrab = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseGrab = false;
    if (e.button === 2) this.rmbHeld = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.lookDX += e.movementX;
    this.lookDY += e.movementY;
  };

  private onContextMenu = (e: Event) => e.preventDefault();

  private onLockChangeEvent = () => {
    const locked = document.pointerLockElement === this.canvas;
    this.pointerLocked = locked;
    if (!locked) {
      this.mouseGrab = false;
      this.rmbHeld = false;
    }
    this.onLockChange?.(locked);
  };

  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    this.markInteract();
    const w = window.innerWidth;
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < w * 0.45 && this.joystick.id === -1) {
        this.joystick.active = true;
        this.joystick.id = t.identifier;
        this.joystick.ox = t.clientX;
        this.joystick.oy = t.clientY;
        this.joystick.dx = 0;
        this.joystick.dy = 0;
        this.joystick.lastActive = performance.now();
      } else if (this.lookTouchId === -1) {
        this.lookTouchId = t.identifier;
        this.lookLastX = t.clientX;
        this.lookLastY = t.clientY;
      }
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.joystick.id) {
        let dx = t.clientX - this.joystick.ox;
        let dy = t.clientY - this.joystick.oy;
        const len = Math.hypot(dx, dy);
        if (len > JOY_RADIUS) {
          dx = (dx / len) * JOY_RADIUS;
          dy = (dy / len) * JOY_RADIUS;
        }
        this.joystick.dx = dx;
        this.joystick.dy = dy;
        this.joystick.lastActive = performance.now();
      } else if (t.identifier === this.lookTouchId) {
        this.lookDX += (t.clientX - this.lookLastX) * TOUCH_LOOK_SCALE;
        this.lookDY += (t.clientY - this.lookLastY) * TOUCH_LOOK_SCALE;
        this.lookLastX = t.clientX;
        this.lookLastY = t.clientY;
      }
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.joystick.id) {
        this.joystick.id = -1;
        this.joystick.active = false;
        this.joystick.dx = 0;
        this.joystick.dy = 0;
      } else if (t.identifier === this.lookTouchId) {
        this.lookTouchId = -1;
      }
    }
  };

  /** screen rotation angle normalized to 0/90/180/270 (legacy iOS uses -90) */
  private screenAngle(): number {
    const a =
      screen.orientation?.angle ??
      (window as unknown as { orientation?: number }).orientation ??
      0;
    return ((a % 360) + 360) % 360;
  }

  private onGyro = (e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null) return;
    this.gyroActive = true;
    const gamma = e.gamma ?? 0;
    if (this.gyroLastA == null || this.gyroLastB == null || this.gyroLastG == null) {
      this.gyroLastA = e.alpha;
      this.gyroLastB = e.beta;
      this.gyroLastG = gamma;
      return;
    }
    // §11.4 gyro look — deltas fuse with drag as offsets.
    const wrap = (d: number) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);
    const da = wrap(e.alpha - this.gyroLastA);
    const db = wrap(e.beta - this.gyroLastB);
    const dg = wrap(gamma - this.gyroLastG);
    this.gyroLastA = e.alpha;
    this.gyroLastB = e.beta;
    this.gyroLastG = gamma;
    // yaw: alpha measures rotation about the earth-vertical axis and increases
    // counter-clockwise (W3C: opposite sense to a compass heading), i.e. it
    // grows when the device turns left — the same sense as player.yaw, so the
    // camera tracks the device's heading 1:1 (matching three.js
    // DeviceOrientationControls, whose camera yaw is +alpha).
    this.gyroDX += (da * Math.PI) / 180;
    // pitch: "screen-top tips toward/away from the user" is carried by beta in
    // portrait, but by gamma in landscape (there beta is roll about the view
    // axis). Signs derived per orientation: tipping the top edge away always
    // pitches the view down (back-of-device camera model):
    //   portrait-primary +db · landscape-primary -dg
    //   portrait-secondary -db · landscape-secondary +dg
    let dp: number;
    switch (this.screenAngle()) {
      case 90:
        dp = -dg;
        break;
      case 180:
        dp = -db;
        break;
      case 270:
        dp = dg;
        break;
      default:
        dp = db;
        break;
    }
    this.gyroDY += (dp * Math.PI) / 180;
  };

  // the Tait-Bryan decomposition jumps when the screen rotates — re-baseline
  private onOrientationChange = () => {
    this.gyroLastA = null;
    this.gyroLastB = null;
    this.gyroLastG = null;
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onLockChangeEvent);
    this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
    this.canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onLockChangeEvent);
    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    this.canvas.removeEventListener('touchend', this.onTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.onTouchEnd);
    this.disableGyro();
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  /* ------------------------------ pointer lock ------------------------------ */

  requestLock(): void {
    if (this.isMobile || this.pointerLocked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      /* unsupported */
    }
  }

  exitLock(): void {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  /* ------------------------------- gyroscope ------------------------------- */

  /** iOS 13+ needs a user-gesture requestPermission; returns false if denied. */
  async enableGyro(): Promise<boolean> {
    try {
      const DOE = DeviceOrientationEvent as unknown as DeviceOrientationEventWithPermission;
      if (typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch {
      return false;
    }
    this.gyroLastA = null;
    this.gyroLastB = null;
    this.gyroLastG = null;
    window.addEventListener('deviceorientation', this.onGyro);
    window.addEventListener('orientationchange', this.onOrientationChange);
    this.gyroEnabled = true;
    return true;
  }

  disableGyro(): void {
    window.removeEventListener('deviceorientation', this.onGyro);
    window.removeEventListener('orientationchange', this.onOrientationChange);
    this.gyroEnabled = false;
    this.gyroActive = false;
    this.gyroLastA = null;
    this.gyroLastB = null;
    this.gyroLastG = null;
    this.gyroDX = 0;
    this.gyroDY = 0;
  }

  /* ------------------------------- frame reads ------------------------------- */

  /** mouse/touch look delta (px-ish) — consumed once per rAF */
  consumeLook(out: LookDelta): LookDelta {
    out.dx = this.lookDX;
    out.dy = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    return out;
  }

  /** gyro look delta (radians, 1:1) — consumed once per rAF */
  consumeGyro(out: LookDelta): LookDelta {
    out.dx = this.gyroDX;
    out.dy = this.gyroDY;
    this.gyroDX = 0;
    this.gyroDY = 0;
    return out;
  }

  consumeRespawn(): boolean {
    const r = this.respawnEdge;
    this.respawnEdge = false;
    return r;
  }

  /** Snapshot for the physics substeps of one rAF. */
  frame(out: FrameInput): FrameInput {
    let mx = 0;
    let my = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) my += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (this.joystick.active) {
      let jx = this.joystick.dx / JOY_RADIUS;
      let jy = this.joystick.dy / JOY_RADIUS;
      const len = Math.hypot(jx, jy);
      if (len < DEADZONE) {
        jx = 0;
        jy = 0;
      } else if (len > 1) {
        jx /= len;
        jy /= len;
      }
      mx += jx;
      my += -jy;
    }
    out.moveX = Math.max(-1, Math.min(1, mx));
    out.moveY = Math.max(-1, Math.min(1, my));
    // mobile 跳: while hanging it's the lunge boost, otherwise a jump;
    // PC Shift is an edge-triggered lunge (hang) + held sprint (ground)
    out.jump = this.jumpEdge && !(this.isMobile && this.hanging);
    out.lunge = this.lungeEdge || (this.jumpEdge && this.isMobile && this.hanging);
    this.jumpEdge = false;
    this.lungeEdge = false;
    out.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    out.grab = this.keys.has('KeyE') || this.mouseGrab || this.touchGrab;
    out.help = this.rmbHeld || this.touchHelp;
    return out;
  }

  /* ------------------------------- mobile buttons ------------------------------- */

  pressJump(): void {
    this.jumpEdge = true;
  }

  setTouchGrab(held: boolean): void {
    this.touchGrab = held;
  }

  /** mobile 拉手 (helping hand) context button */
  setTouchHelp(held: boolean): void {
    this.touchHelp = held;
  }
}
