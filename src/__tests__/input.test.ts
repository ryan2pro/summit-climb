/**
 * Input tests — keyboard mapping + edge-trigger semantics of InputManager
 * (jsdom DOM events; no pointer lock involved), plus gyro look-mapping
 * sign conventions per screen orientation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputManager, type LookDelta } from '@/game/input';
import type { FrameInput } from '@/game/player';

let canvas: HTMLCanvasElement;
let im: InputManager;
const out: FrameInput = { moveX: 0, moveY: 0, jump: false, lunge: false, sprint: false, grab: false, help: false };

function key(type: 'keydown' | 'keyup', code: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
}

beforeEach(() => {
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  im = new InputManager(canvas, false);
  im.attach();
});

afterEach(() => {
  im.dispose();
  canvas.remove();
});

describe('input: keyboard mapping', () => {
  it('maps WASD/arrows to move axes', () => {
    key('keydown', 'KeyW');
    im.frame(out);
    expect(out.moveY).toBe(1);
    key('keyup', 'KeyW');
    key('keydown', 'ArrowDown');
    im.frame(out);
    expect(out.moveY).toBe(-1);
    key('keydown', 'KeyA');
    im.frame(out);
    expect(out.moveX).toBe(-1);
    key('keyup', 'KeyA');
    key('keydown', 'ArrowRight');
    im.frame(out);
    expect(out.moveX).toBe(1);
  });

  it('clamps combined axes to [-1, 1]', () => {
    key('keydown', 'KeyW');
    key('keydown', 'ArrowUp');
    key('keydown', 'KeyD');
    im.frame(out);
    expect(out.moveY).toBe(1);
    expect(out.moveX).toBe(1);
  });

  it('jump is an edge consumed by exactly one frame()', () => {
    key('keydown', 'Space');
    im.frame(out);
    expect(out.jump).toBe(true);
    im.frame(out);
    expect(out.jump).toBe(false); // consumed — no auto-repeat
  });

  it('pressJump() (mobile button) also produces one jump edge', () => {
    im.pressJump();
    im.frame(out);
    expect(out.jump).toBe(true);
    im.frame(out);
    expect(out.jump).toBe(false);
  });

  it('E hold maps to grab; keyup releases', () => {
    key('keydown', 'KeyE');
    im.frame(out);
    expect(out.grab).toBe(true);
    key('keyup', 'KeyE');
    im.frame(out);
    expect(out.grab).toBe(false);
  });

  it('R produces a one-shot respawn edge', () => {
    expect(im.consumeRespawn()).toBe(false);
    key('keydown', 'KeyR');
    expect(im.consumeRespawn()).toBe(true);
    expect(im.consumeRespawn()).toBe(false);
  });

  it('Shift: held sprint + one lunge edge', () => {
    key('keydown', 'ShiftLeft');
    im.frame(out);
    expect(out.sprint).toBe(true);
    expect(out.lunge).toBe(true);
    im.frame(out);
    expect(out.sprint).toBe(true); // still held
    expect(out.lunge).toBe(false); // edge consumed
    key('keyup', 'ShiftLeft');
    im.frame(out);
    expect(out.sprint).toBe(false);
  });

  it('RMB (pointer-locked) maps to help while held', () => {
    im.pointerLocked = true;
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    im.frame(out);
    expect(out.help).toBe(true);
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    im.frame(out);
    expect(out.help).toBe(false);
  });

  it('mobile 跳 while hanging = lunge (not jump); on the ground = jump', () => {
    const c2 = document.createElement('canvas');
    document.body.appendChild(c2);
    const mob = new InputManager(c2, true);
    mob.attach();
    try {
      mob.hanging = true;
      mob.pressJump();
      mob.frame(out);
      expect(out.lunge).toBe(true);
      expect(out.jump).toBe(false);
      mob.hanging = false;
      mob.pressJump();
      mob.frame(out);
      expect(out.jump).toBe(true);
      expect(out.lunge).toBe(false);
    } finally {
      mob.dispose();
      c2.remove();
    }
  });

  it('mobile 拉手 button maps to help while held', () => {
    im.setTouchHelp(true);
    im.frame(out);
    expect(out.help).toBe(true);
    im.setTouchHelp(false);
    im.frame(out);
    expect(out.help).toBe(false);
  });

  it('window blur clears held keys (no stuck movement)', () => {
    key('keydown', 'KeyW');
    window.dispatchEvent(new Event('blur'));
    im.frame(out);
    expect(out.moveY).toBe(0);
  });
});

describe('input: joystick + look', () => {
  it('applies the 10% deadzone and radial clamp', () => {
    // inside deadzone (0.1 * 56px radius)
    im.joystick.active = true;
    im.joystick.dx = 3;
    im.joystick.dy = 3;
    im.frame(out);
    expect(out.moveX).toBe(0);
    expect(out.moveY).toBe(0);
    // past deadzone; dy maps to inverted moveY
    im.joystick.dx = 28;
    im.joystick.dy = -28;
    im.frame(out);
    expect(out.moveX).toBeCloseTo(0.5, 3);
    expect(out.moveY).toBeCloseTo(0.5, 3);
    // inactive joystick is ignored
    im.joystick.active = false;
    im.frame(out);
    expect(out.moveX).toBe(0);
    expect(out.moveY).toBe(0);
  });

  it('consumeLook returns the accumulated delta once', () => {
    const look: LookDelta = { dx: 0, dy: 0 };
    (im as unknown as { lookDX: number; lookDY: number }).lookDX = 42;
    (im as unknown as { lookDX: number; lookDY: number }).lookDY = -7;
    im.consumeLook(look);
    expect(look.dx).toBe(42);
    expect(look.dy).toBe(-7);
    im.consumeLook(look);
    expect(look.dx).toBe(0);
    expect(look.dy).toBe(0);
  });
});

describe('input: gyro look mapping', () => {
  type GyroEvent = { alpha: number; beta: number; gamma: number };
  const gyro = (m: InputManager, e: GyroEvent): void => {
    (m as unknown as { onGyro: (ev: GyroEvent) => void }).onGyro(e);
  };
  const setAngle = (m: InputManager, a: number): void => {
    (m as unknown as { screenAngle: () => number }).screenAngle = () => a;
  };
  const DEG = Math.PI / 180;
  const look: LookDelta = { dx: 0, dy: 0 };

  it('yaw tracks +alpha 1:1 (alpha grows turning left = player.yaw sense)', () => {
    setAngle(im, 0);
    gyro(im, { alpha: 100, beta: 80, gamma: 5 }); // baseline
    gyro(im, { alpha: 110, beta: 80, gamma: 5 }); // +10° (turn left)
    im.consumeGyro(look);
    expect(look.dx).toBeCloseTo(10 * DEG, 5);
    expect(look.dy).toBeCloseTo(0, 6);
  });

  it('yaw wraps across the 0/360 boundary', () => {
    setAngle(im, 0);
    gyro(im, { alpha: 359, beta: 90, gamma: 0 });
    gyro(im, { alpha: 1, beta: 90, gamma: 0 }); // +2° wrapped
    im.consumeGyro(look);
    expect(look.dx).toBeCloseTo(2 * DEG, 5);
  });

  it('portrait-primary (0°): tipping the top edge away (beta falls) pitches down', () => {
    setAngle(im, 0);
    gyro(im, { alpha: 0, beta: 90, gamma: 0 });
    gyro(im, { alpha: 0, beta: 80, gamma: 0 }); // -10° beta
    im.consumeGyro(look);
    expect(look.dy).toBeCloseTo(-10 * DEG, 5);
  });

  it('landscape-primary (90°): pitch comes from -gamma; beta (roll) is ignored', () => {
    setAngle(im, 90);
    gyro(im, { alpha: 0, beta: 5, gamma: 0 });
    gyro(im, { alpha: 0, beta: 45, gamma: 10 }); // big beta swing must not pitch
    im.consumeGyro(look);
    expect(look.dy).toBeCloseTo(-10 * DEG, 5);
  });

  it('landscape-secondary (270°): pitch comes from +gamma', () => {
    setAngle(im, 270);
    gyro(im, { alpha: 0, beta: 5, gamma: 0 });
    gyro(im, { alpha: 0, beta: 5, gamma: -10 });
    im.consumeGyro(look);
    expect(look.dy).toBeCloseTo(-10 * DEG, 5);
  });

  it('portrait-secondary (180°): pitch comes from -beta', () => {
    setAngle(im, 180);
    gyro(im, { alpha: 0, beta: -80, gamma: 0 });
    gyro(im, { alpha: 0, beta: -70, gamma: 0 }); // +10° beta
    im.consumeGyro(look);
    expect(look.dy).toBeCloseTo(-10 * DEG, 5);
  });
});
