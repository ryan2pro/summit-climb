/**
 * Remotes — remote climber avatars (design.md §11.5 / game.md §3).
 *
 * Low-poly climbers in player colors (capsule body + head + cosmetic hat +
 * mini backpack + swinging arms/legs), canvas-sprite name tags (fade beyond
 * 40m), emote bubbles (2s spring pop, flat icons), 120ms interpolation
 * buffer (lerp position, shortest-arc yaw), pose states from net bitflags
 * (moving bob / hang stretch / exhausted slump / falling flail), fade+sink
 * removal on leave.
 */

import * as THREE from 'three';
import type { EmoteKind, PlayerInfo, PlayerId, RemoteState } from '@/lib/net';

interface Snapshot {
  t: number;
  x: number;
  y: number;
  z: number;
  ry: number;
  pitch: number;
  f: number;
}

interface RemoteEntry {
  id: PlayerId;
  name: string;
  group: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  head: THREE.Mesh;
  tag: THREE.Sprite;
  tagMat: THREE.SpriteMaterial;
  tagTex: THREE.CanvasTexture;
  bubble: THREE.Sprite;
  bubbleMat: THREE.SpriteMaterial;
  snaps: Snapshot[];
  altitude: number;
  lastSeen: number;
  leavingAt: number;
  bubbleStart: number;
  bubbleUntil: number;
  walkPhase: number;
  lastX: number;
  lastZ: number;
}

const INTERP_DELAY = 0.12;
const SNAP_KEEP = 1.2;

/* shared geometries across all avatars */
const GEO = {
  body: new THREE.CapsuleGeometry(0.3, 0.6, 3, 8),
  head: new THREE.SphereGeometry(0.21, 10, 8),
  beanie: new THREE.SphereGeometry(0.225, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
  pom: new THREE.SphereGeometry(0.07, 6, 5),
  bandana: new THREE.ConeGeometry(0.23, 0.22, 8),
  goggles: new THREE.BoxGeometry(0.32, 0.09, 0.1),
  carabiner: new THREE.TorusGeometry(0.07, 0.022, 6, 12),
  pack: new THREE.BoxGeometry(0.36, 0.42, 0.17),
  flag: new THREE.BoxGeometry(0.26, 0.16, 0.02),
  arm: new THREE.CapsuleGeometry(0.085, 0.4, 3, 6),
  leg: new THREE.CapsuleGeometry(0.105, 0.4, 3, 6),
};

const SKIN = new THREE.Color('#F2D7B6');
const PACK = new THREE.Color('#E9DCC0');
const GOLD = new THREE.Color('#E8A94C');
const DARK = new THREE.Color('#2E2418');
const FLAG_RED = new THREE.Color('#D0713F');

function std(color: THREE.Color | string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 1, metalness: 0 });
}

/* ------------------------------ canvas sprites ------------------------------ */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeTagTexture(name: string, color: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = 'rgba(24,17,10,0.72)';
  roundRect(ctx, 6, 8, 244, 48, 24);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(34, 32, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#F6F2E9';
  ctx.font = '700 26px "Noto Sans SC", sans-serif';
  ctx.textBaseline = 'middle';
  const label = name.length > 8 ? `${name.slice(0, 8)}…` : name;
  ctx.fillText(label, 54, 34, 184);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const emoteTexCache = new Map<EmoteKind, THREE.CanvasTexture>();

function makeEmoteTexture(kind: EmoteKind): THREE.CanvasTexture {
  const cached = emoteTexCache.get(kind);
  if (cached) return cached;
  const cv = document.createElement('canvas');
  cv.width = 96;
  cv.height = 96;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = 'rgba(24,17,10,0.8)';
  ctx.beginPath();
  ctx.arc(48, 48, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#E8A94C';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = '#F6F2E9';
  ctx.fillStyle = '#F6F2E9';
  ctx.lineWidth = 6;
  if (kind === 'wave') {
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(40, 56, 12 + i * 9, -Math.PI * 0.75, -Math.PI * 0.25);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(40, 56, 4, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'cheer') {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(48 + Math.cos(a) * 12, 48 + Math.sin(a) * 12);
      ctx.lineTo(48 + Math.cos(a) * 28, 48 + Math.sin(a) * 28);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(48, 48, 7, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'point') {
    ctx.beginPath();
    ctx.moveTo(26, 48);
    ctx.lineTo(58, 48);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(52, 34);
    ctx.lineTo(74, 48);
    ctx.lineTo(52, 62);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.font = '700 30px "Fredoka", "Noto Sans SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SOS', 48, 50);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  emoteTexCache.set(kind, tex);
  return tex;
}

/* --------------------------------- avatars --------------------------------- */

function buildAvatar(info: PlayerInfo): RemoteEntry {
  const group = new THREE.Group();
  const color = new THREE.Color(info.color || '#D0713F');
  const bodyMat = std(color);
  const accent = color.clone().multiplyScalar(0.72);

  const body = new THREE.Mesh(GEO.body, bodyMat);
  body.position.y = 0.92;
  group.add(body);

  const head = new THREE.Mesh(GEO.head, std(SKIN));
  head.position.y = 1.52;
  group.add(head);

  // cosmetics (§11.7)
  const cosmetic = info.cosmetic || 'beanie';
  if (cosmetic === 'bandana') {
    const m = new THREE.Mesh(GEO.bandana, std(FLAG_RED));
    m.position.y = 1.66;
    group.add(m);
  } else {
    const m = new THREE.Mesh(GEO.beanie, std(accent));
    m.position.y = 1.585;
    m.scale.y = 0.78;
    group.add(m);
    const pom = new THREE.Mesh(GEO.pom, std(PACK));
    pom.position.y = 1.75;
    group.add(pom);
    if (cosmetic === 'goggles') {
      const g = new THREE.Mesh(GEO.goggles, std(DARK));
      g.position.set(0, 1.55, 0.17);
      group.add(g);
    }
  }

  const pack = new THREE.Mesh(GEO.pack, std(PACK));
  pack.position.set(0, 1.02, -0.28);
  group.add(pack);
  if (cosmetic === 'carabiner') {
    const c = new THREE.Mesh(GEO.carabiner, std(GOLD));
    c.position.set(0.2, 0.92, -0.3);
    c.rotation.y = Math.PI / 2;
    group.add(c);
  }
  if (cosmetic === 'champion') {
    const f = new THREE.Mesh(GEO.flag, std(FLAG_RED));
    f.position.set(0, 1.14, -0.38);
    group.add(f);
  }

  const mkLimb = (geo: THREE.BufferGeometry, x: number, y: number, mat: THREE.MeshStandardMaterial) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -0.26;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  };
  const armL = mkLimb(GEO.arm, -0.4, 1.3, bodyMat);
  const armR = mkLimb(GEO.arm, 0.4, 1.3, bodyMat);
  const legL = mkLimb(GEO.leg, -0.15, 0.62, std(DARK));
  const legR = mkLimb(GEO.leg, 0.15, 0.62, std(DARK));

  const tagTex = makeTagTexture(info.name, info.color || '#D0713F');
  const tagMat = new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthWrite: false });
  const tag = new THREE.Sprite(tagMat);
  tag.scale.set(1.45, 0.36, 1);
  tag.position.y = 2.02;
  group.add(tag);

  const bubbleMat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0 });
  const bubble = new THREE.Sprite(bubbleMat);
  bubble.scale.setScalar(0.001);
  bubble.position.y = 2.5;
  group.add(bubble);

  return {
    id: info.id,
    name: info.name,
    group,
    bodyMat,
    armL,
    armR,
    legL,
    legR,
    head,
    tag,
    tagMat,
    tagTex,
    bubble,
    bubbleMat,
    snaps: [],
    altitude: 0,
    lastSeen: performance.now() / 1000,
    leavingAt: -1,
    bubbleStart: 0,
    bubbleUntil: 0,
    walkPhase: 0,
    lastX: 0,
    lastZ: 0,
  };
}

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class RemoteManager {
  private scene: THREE.Scene;
  private entries = new Map<PlayerId, RemoteEntry>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Reconcile with the host roster (self excluded by caller). */
  syncRoster(players: PlayerInfo[], selfId: PlayerId): void {
    const seen = new Set<PlayerId>();
    for (const p of players) {
      if (p.id === selfId) continue;
      seen.add(p.id);
      if (!this.entries.has(p.id)) {
        const e = buildAvatar(p);
        e.group.visible = false;
        this.entries.set(p.id, e);
        this.scene.add(e.group);
      }
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.removePlayer(id);
    }
  }

  removePlayer(id: PlayerId): void {
    const e = this.entries.get(id);
    if (!e || e.leavingAt >= 0) return;
    e.leavingAt = performance.now() / 1000;
  }

  pushState(st: RemoteState): void {
    const e = this.entries.get(st.id);
    if (!e || e.leavingAt >= 0) return;
    const now = performance.now() / 1000;
    e.lastSeen = now;
    e.snaps.push({ t: now, x: st.p[0], y: st.p[1], z: st.p[2], ry: st.ry, pitch: st.pitch, f: st.f });
    while (e.snaps.length > 2 && e.snaps[0].t < now - SNAP_KEEP) e.snaps.shift();
  }

  /** seconds since the last 15Hz state snapshot (ICE-loss heartbeat) */
  getLastSeen(id: PlayerId): number | null {
    const e = this.entries.get(id);
    return e ? e.lastSeen : null;
  }

  showEmote(id: PlayerId, kind: EmoteKind): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.bubbleMat.map = makeEmoteTexture(kind);
    e.bubbleMat.needsUpdate = true;
    e.bubbleStart = performance.now() / 1000;
    e.bubbleUntil = e.bubbleStart + 2;
  }

  getAltitude(id: PlayerId): number | null {
    const e = this.entries.get(id);
    return e ? e.altitude : null;
  }

  forEach(cb: (id: PlayerId, altitude: number, name: string) => void): void {
    for (const e of this.entries.values()) cb(e.id, e.altitude, e.name);
  }

  update(dt: number, camera: THREE.Camera): void {
    const now = performance.now() / 1000;
    const rt = now - INTERP_DELAY;
    for (const e of this.entries.values()) {
      // fade + sink on leave (400ms)
      if (e.leavingAt >= 0) {
        const k = (now - e.leavingAt) / 0.4;
        if (k >= 1) {
          this.scene.remove(e.group);
          e.bodyMat.dispose();
          e.tagMat.dispose();
          e.tagTex.dispose();
          e.bubbleMat.dispose();
          this.entries.delete(e.id);
          continue;
        }
        e.group.position.y -= dt * 1.1;
        e.tagMat.opacity = 1 - k;
        continue;
      }

      const snaps = e.snaps;
      if (snaps.length === 0) {
        e.group.visible = false;
        continue;
      }
      e.group.visible = true;
      let a = snaps[0];
      let b = snaps[snaps.length - 1];
      for (let i = 0; i < snaps.length - 1; i++) {
        if (snaps[i].t <= rt && snaps[i + 1].t >= rt) {
          a = snaps[i];
          b = snaps[i + 1];
          break;
        }
      }
      if (rt >= b.t) a = b;
      if (rt <= a.t) b = a;
      const span = Math.max(1e-4, b.t - a.t);
      const t = Math.min(1.25, Math.max(0, (rt - a.t) / span));
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const pz = a.z + (b.z - a.z) * t;
      const ry = lerpAngle(a.ry, b.ry, t);
      const pitch = a.pitch + (b.pitch - a.pitch) * t;
      const f = b.f;

      // walk cycle from actual displacement
      const dx = px - e.lastX;
      const dz = pz - e.lastZ;
      e.lastX = px;
      e.lastZ = pz;
      const step = Math.hypot(dx, dz);
      if (step < 1) e.walkPhase += step * 4.2;

      e.group.position.set(px, py, pz);
      e.group.rotation.y = ry;
      e.altitude = py;

      // pose from flags (1=moving 2=hanging 4=exhausted 8=falling)
      const hanging = (f & 2) !== 0;
      const exhausted = (f & 4) !== 0;
      const falling = (f & 8) !== 0;
      const moving = (f & 1) !== 0;
      const swing = Math.sin(e.walkPhase) * 0.55;
      let aLx = 0;
      let aLz = 0;
      let aRx = 0;
      let aRz = 0;
      let lLx = 0;
      let lRx = 0;
      if (hanging) {
        aLz = 2.55;
        aRz = -2.55;
        lLx = 0.35;
        lRx = -0.2;
      } else if (falling) {
        aLz = 1.1 + Math.sin(now * 17) * 0.7;
        aRz = -1.1 - Math.cos(now * 15) * 0.7;
        lLx = Math.sin(now * 13) * 0.5;
        lRx = -lLx;
      } else if (moving) {
        aLx = swing * 0.7;
        aRx = -swing * 0.7;
        lLx = -swing;
        lRx = swing;
      }
      if (exhausted) {
        e.group.rotation.x = 0.16;
        aLx = 0.3;
        aRx = 0.3;
        aLz = 0.25;
        aRz = -0.25;
      } else {
        e.group.rotation.x = 0;
      }
      const k = Math.min(1, dt * 10);
      e.armL.rotation.x += (aLx - e.armL.rotation.x) * k;
      e.armL.rotation.z += (aLz - e.armL.rotation.z) * k;
      e.armR.rotation.x += (aRx - e.armR.rotation.x) * k;
      e.armR.rotation.z += (aRz - e.armR.rotation.z) * k;
      e.legL.rotation.x += (lLx - e.legL.rotation.x) * k;
      e.legR.rotation.x += (lRx - e.legR.rotation.x) * k;
      e.head.rotation.x = THREE.MathUtils.clamp(-pitch * 0.55, -0.6, 0.6);

      // name tag fades beyond 40m
      const d = e.group.position.distanceTo(camera.position);
      e.tagMat.opacity = THREE.MathUtils.clamp(1 - (d - 40) / 10, 0, 1) * 0.95;

      // emote bubble: spring pop in, 2s, fade out
      if (now < e.bubbleUntil) {
        const since = now - e.bubbleStart;
        const pop = Math.min(1, since / 0.22);
        const over = 1 + 0.35 * Math.sin(pop * Math.PI) * (1 - pop);
        e.bubble.scale.setScalar(Math.max(0.001, 0.58 * pop * over));
        e.bubbleMat.opacity = Math.min(1, (e.bubbleUntil - now) / 0.3);
      } else {
        e.bubbleMat.opacity = 0;
        e.bubble.scale.setScalar(0.001);
      }
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      this.scene.remove(e.group);
      e.bodyMat.dispose();
      e.tagMat.dispose();
      e.tagTex.dispose();
      e.bubbleMat.dispose();
    }
    this.entries.clear();
  }
}
