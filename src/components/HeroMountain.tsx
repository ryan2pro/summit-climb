import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import HeroPoster from '@/components/HeroPoster';
import { rngFromSeed, randRange } from '@/lib/prng';

/**
 * Real-time Three.js hero mountain (home.md §1) — a lightweight seeded
 * low-poly mountain with a spiral of amber holds, checkpoint flags, drifting
 * clouds, fluttering summit pennant and floating pollen dust.
 *
 * Performance contract (design.md §12):
 *  - single WebGL context on the page, disposed on unmount
 *  - paused when the tab is hidden and when the hero scrolls out of view
 *  - DPR capped (2 desktop / 1.5 mobile)
 *  - static fallback poster (/hero-fallback.svg) when WebGL is unavailable
 *
 * Scroll scrub: the parent writes 0..1 progress into `scrollRef.current`;
 * the camera dollies forward & up and clouds drift faster as it rises.
 */

const SHOWCASE_SEED = 20250607;
const H = 120; // mountain height (showcase params, design home.md §1)
const R = 95; // mountain radius

/* ---------- seeded value noise (fixed order, deterministic) ---------- */

function makeNoise(seed: number) {
  const rng = rngFromSeed(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h: number, x: number, y: number) => ((h & 1) === 0 ? x : -x) + ((h & 2) === 0 ? y : -y);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const noise2 = (x: number, y: number) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = fade(x);
    const v = fade(y);
    const a = perm[X] + Y;
    const b = perm[X + 1] + Y;
    return (
      (1 - v) * ((1 - u) * grad(perm[a & 255], x, y) + u * grad(perm[b & 255], x - 1, y)) +
      v * ((1 - u) * grad(perm[a + 1 & 255], x, y - 1) + u * grad(perm[b + 1 & 255], x - 1, y - 1))
    );
  };
  return (x: number, y: number) => {
    // 3-octave ridge noise
    let f = 0;
    let amp = 0.55;
    let freq = 1;
    for (let o = 0; o < 3; o++) {
      f += amp * (1 - Math.abs(noise2(x * freq, y * freq))); // ridged
      amp *= 0.5;
      freq *= 2.1;
    }
    return f; // ~0..1.1
  };
}

const PAL = {
  skyTop: new THREE.Color('#8FB9CE'),
  skyHor: new THREE.Color('#F6DDBB'),
  sun: new THREE.Color('#FFE3B3'),
  hemiSky: new THREE.Color('#BFD3DC'),
  hemiGround: new THREE.Color('#C9AE86'),
  fog: new THREE.Color('#E9D7BC'),
  meadow: new THREE.Color('#A9B388'),
  forest: new THREE.Color('#6F8F67'),
  trunk: new THREE.Color('#8A6B4E'),
  rockLo: new THREE.Color('#B99B7B'),
  rockMid: new THREE.Color('#9B8571'),
  rockHi: new THREE.Color('#8A7D76'),
  snow: new THREE.Color('#F2EFE7'),
  amber: new THREE.Color('#E8A94C'),
  terracotta: new THREE.Color('#D0713F'),
  cloud: new THREE.Color('#FBF4E6'),
};

function isWebGLAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export interface HeroMountainProps {
  /** shared scroll progress 0..1, written by the parent's ScrollTrigger */
  scrollRef: { current: number };
}

export default function HeroMountain({ scrollRef }: HeroMountainProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  // lazy one-time WebGL capability check (no setState inside the effect)
  const [failed] = useState(() => !isWebGLAvailable());

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || failed) return;

    const rng = rngFromSeed(SHOWCASE_SEED);
    const noise = makeNoise(SHOWCASE_SEED ^ 0x9e3779b9);

    /* height function: base cone + ridged noise + terracing (design §11.1, light) */
    const heightAt = (x: number, z: number): number => {
      const r = Math.hypot(x, z);
      const base = H * Math.max(0, 1 - r / R);
      if (base <= 0) return 0;
      const n = noise(x / 38 + 7.3, z / 38 - 2.1); // fixed offset, seeded fn
      let y = base * (0.72 + 0.42 * n);
      // plateau flattening near the summit
      const t = y / H;
      if (t > 0.96) y = H * 0.96 + (y - H * 0.96) * 0.15;
      // terracing (chunky ledges)
      const step = 2.5;
      y = y + (Math.round(y / step) * step - y) * 0.35;
      return y;
    };

    /* ------------------------------ renderer ------------------------------ */
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(PAL.fog, 60, 260);

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / Math.max(1, mount.clientHeight), 0.1, 1200);

    /* lights — warm sun key + hemisphere (design §2.2) */
    const sunLight = new THREE.DirectionalLight(PAL.sun, 2.6);
    sunLight.position.set(160, 95, 70);
    scene.add(sunLight);
    const hemi = new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 1.0);
    scene.add(hemi);

    /* gradient sky dome */
    const domeGeo = new THREE.SphereGeometry(600, 24, 12);
    const domeColors: number[] = [];
    const pos = domeGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp(pos.getY(i) / 600, 0, 1);
      const c = PAL.skyHor.clone().lerp(PAL.skyTop, Math.pow(t, 0.7));
      domeColors.push(c.r, c.g, c.b);
    }
    domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(domeColors, 3));
    const dome = new THREE.Mesh(
      domeGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }),
    );
    scene.add(dome);

    /* world group (offset right-of-middle on desktop) */
    const world = new THREE.Group();
    const worldOffset = mount.clientWidth >= 768 ? 34 : 0;
    world.position.x = worldOffset;
    scene.add(world);

    const std = (color: THREE.Color, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 1, metalness: 0, ...extra });

    /* ------------------------------ mountain ------------------------------ */
    const SEG = 96;
    const RINGS = 48;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let j = 0; j <= RINGS; j++) {
      const r = (R * j) / RINGS;
      for (let i = 0; i <= SEG; i++) {
        const th = (i / SEG) * Math.PI * 2;
        const x = Math.cos(th) * r;
        const z = Math.sin(th) * r;
        const y = heightAt(x, z);
        positions.push(x, y, z);
        const t = THREE.MathUtils.clamp(y / H, 0, 1);
        let c: THREE.Color;
        if (t < 0.3) c = PAL.meadow.clone().lerp(PAL.rockLo, t / 0.3);
        else if (t < 0.72) c = PAL.rockLo.clone().lerp(PAL.rockHi, (t - 0.3) / 0.42);
        else c = PAL.rockHi.clone().lerp(PAL.snow, Math.min(1, ((t - 0.72) / 0.28) * 1.5));
        const mottle = 0.92 + noise(x / 9 + 31, z / 9 - 17) * 0.16;
        colors.push(c.r * mottle, c.g * mottle, c.b * mottle);
      }
    }
    for (let j = 0; j < RINGS; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * (SEG + 1) + i;
        const b = a + 1;
        const c = a + SEG + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const mtnGeo = new THREE.BufferGeometry();
    mtnGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    mtnGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    mtnGeo.setIndex(indices);
    mtnGeo.computeVertexNormals();
    const mountain = new THREE.Mesh(
      mtnGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 }),
    );
    world.add(mountain);

    /* ground disc */
    const ground = new THREE.Mesh(new THREE.CircleGeometry(500, 48), std(PAL.meadow));
    ground.rotation.x = -Math.PI / 2;
    world.add(ground);

    /* --------------------------- spiral of holds --------------------------- */
    // find surface radius for a target altitude by descending scan
    const surfacePoint = (theta: number, targetY: number): THREE.Vector3 => {
      let r = R * (1 - targetY / H) + 6;
      for (let k = 0; k < 8; k++) {
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        const y = heightAt(x, z);
        if (y < targetY) r -= 1.6;
        else r += 0.9;
        r = THREE.MathUtils.clamp(r, 0, R);
      }
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;
      return new THREE.Vector3(x, heightAt(x, z), z);
    };

    const holdGeo = new THREE.IcosahedronGeometry(1, 0);
    holdGeo.scale(1, 0.62, 1);
    const holdMat = std(PAL.amber.clone().lerp(PAL.rockMid, 0.35), {
      emissive: PAL.amber,
      emissiveIntensity: 0.18,
    });
    const holdPositions: THREE.Vector3[] = [];
    {
      let theta = randRange(rng, 0, Math.PI * 2);
      let y = 4;
      while (y < H * 0.94) {
        holdPositions.push(surfacePoint(theta, y));
        theta += randRange(rng, 0.45, 0.95);
        y += randRange(rng, 2.0, 3.4);
      }
    }
    const holds = new THREE.InstancedMesh(holdGeo, holdMat, holdPositions.length);
    {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      holdPositions.forEach((p, i) => {
        const s = randRange(rng, 0.9, 1.5);
        q.setFromUnitVectors(up, p.clone().normalize());
        m.compose(p.clone().multiplyScalar(1.004).add(new THREE.Vector3(0, 0.25, 0)), q, new THREE.Vector3(s, s, s));
        holds.setMatrixAt(i, m);
      });
    }
    world.add(holds);

    /* ------------------------ checkpoint + summit flags ------------------------ */
    const flagGroup = new THREE.Group();
    const poleMat = std(new THREE.Color('#7A5C40'));
    const clothMat = std(PAL.terracotta, { side: THREE.DoubleSide });
    const makeFlag = (scale: number) => {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * scale, 0.18 * scale, 5 * scale, 6), poleMat);
      pole.position.y = 2.5 * scale;
      g.add(pole);
      const clothGeo = new THREE.PlaneGeometry(3.2 * scale, 1.7 * scale, 6, 3);
      clothGeo.translate(1.6 * scale, 0, 0);
      const cloth = new THREE.Mesh(clothGeo, clothMat);
      cloth.position.y = 4 * scale;
      g.add(cloth);
      return { group: g, cloth };
    };
    const flutterCloths: { mesh: THREE.Mesh; base: Float32Array; phase: number }[] = [];
    const addFlag = (p: THREE.Vector3, scale: number, phase: number) => {
      const { group, cloth } = makeFlag(scale);
      group.position.copy(p);
      group.rotation.y = randRange(rng, 0, Math.PI * 2);
      flagGroup.add(group);
      flutterCloths.push({ mesh: cloth, base: (cloth.geometry.attributes.position.array as Float32Array).slice(), phase });
    };
    // checkpoint flags along the route
    [0.22, 0.42, 0.62, 0.8].forEach((t) => {
      const idx = Math.floor(t * (holdPositions.length - 1));
      addFlag(holdPositions[idx], 0.85, t * 6);
    });
    // summit flag
    addFlag(new THREE.Vector3(0, H * 0.962, 0), 1.7, 0);
    world.add(flagGroup);

    /* ------------------------------- trees ------------------------------- */
    const treeCone = new THREE.ConeGeometry(1, 2.6, 7);
    const treeTrunk = new THREE.CylinderGeometry(0.16, 0.22, 0.9, 6);
    const treeCount = 60;
    const cones = new THREE.InstancedMesh(treeCone, std(PAL.forest), treeCount * 2);
    const trunks = new THREE.InstancedMesh(treeTrunk, std(PAL.trunk), treeCount);
    {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      for (let i = 0; i < treeCount; i++) {
        const th = randRange(rng, 0, Math.PI * 2);
        const rr = randRange(rng, R * 0.95, R * 1.5);
        const x = Math.cos(th) * rr;
        const z = Math.sin(th) * rr;
        const y = heightAt(x, z);
        const s = randRange(rng, 1.4, 2.6);
        m.compose(new THREE.Vector3(x, y + 0.4 * s, z), q, new THREE.Vector3(s, s, s));
        trunks.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(x, y + (0.9 + 1.1) * s, z), q, new THREE.Vector3(s, s, s));
        cones.setMatrixAt(i * 2, m);
        m.compose(new THREE.Vector3(x, y + (0.9 + 2.1) * s, z), q, new THREE.Vector3(s * 0.72, s * 0.8, s * 0.72));
        cones.setMatrixAt(i * 2 + 1, m);
      }
    }
    world.add(cones, trunks);

    /* scattered rocks */
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rocks = new THREE.InstancedMesh(rockGeo, std(PAL.rockMid), 24);
    {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      for (let i = 0; i < 24; i++) {
        const th = randRange(rng, 0, Math.PI * 2);
        const rr = randRange(rng, R * 0.5, R * 1.35);
        const x = Math.cos(th) * rr;
        const z = Math.sin(th) * rr;
        const s = randRange(rng, 0.7, 2.1);
        q.setFromEuler(e.set(randRange(rng, 0, 3), randRange(rng, 0, 3), randRange(rng, 0, 3)));
        m.compose(new THREE.Vector3(x, heightAt(x, z) + s * 0.3, z), q, new THREE.Vector3(s, s * 0.75, s));
        rocks.setMatrixAt(i, m);
      }
    }
    world.add(rocks);

    /* ------------------------------- clouds ------------------------------- */
    const cloudMat = std(PAL.cloud, { roughness: 1 });
    const clouds: { group: THREE.Group; speed: number; angle: number; radius: number; y: number }[] = [];
    for (let c = 0; c < 4; c++) {
      const g = new THREE.Group();
      const blobs = 3 + Math.floor(rng() * 2);
      for (let b = 0; b < blobs; b++) {
        const s = randRange(rng, 4, 9);
        const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), cloudMat);
        mesh.position.set(randRange(rng, -8, 8), randRange(rng, -1.5, 1.5), randRange(rng, -4, 4));
        mesh.scale.y = 0.55;
        g.add(mesh);
      }
      const angle = randRange(rng, 0, Math.PI * 2);
      const radius = randRange(rng, R * 1.1, R * 1.7);
      const y = randRange(rng, H * 0.55, H * 1.05);
      g.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      world.add(g);
      clouds.push({ group: g, speed: randRange(rng, 0.008, 0.02), angle, radius, y });
    }

    /* ------------------------------- pollen dust ------------------------------- */
    const DUST = 60;
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = new Float32Array(DUST * 3);
    const dustSeed = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      const th = rng() * Math.PI * 2;
      const rr = R * (0.4 + rng() * 1.1);
      dustPos[i * 3] = Math.cos(th) * rr;
      dustPos[i * 3 + 1] = rng() * H * 1.1;
      dustPos[i * 3 + 2] = Math.sin(th) * rr;
      dustSeed[i] = rng() * 100;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: PAL.amber, size: 1.4, sizeAttenuation: true, transparent: true, opacity: 0.75 }),
    );
    world.add(dust);

    /* ------------------------------ animation ------------------------------ */
    let raf = 0;
    let running = true;
    let inView = true;
    let visible = !document.hidden;
    const clock = new THREE.Clock();
    let azimuth = randRange(rng, 0, Math.PI * 2);
    let elapsed = 0;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const onPointer = (ev: PointerEvent) => {
      if (coarse) return;
      const rect = mount.getBoundingClientRect();
      pointer.tx = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      pointer.ty = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0.02 },
    );
    io.observe(mount);
    const onVis = () => {
      visible = !document.hidden;
    };
    document.addEventListener('visibilitychange', onVis);

    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (!running || !inView || !visible) {
        clock.getDelta();
        return;
      }
      const dt = Math.min(clock.getDelta(), 0.05);
      elapsed += dt;
      const p = THREE.MathUtils.clamp(scrollRef.current, 0, 1);

      // pointer parallax (±0.03 rad, lerp 0.05)
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;

      // camera: gentle orbit, scrub dollies forward & up (home.md §1)
      azimuth += 0.02 * dt * (1 - p * 0.8); // orbit pauses as we dolly
      const az = azimuth + pointer.x * 0.03;
      const radius = THREE.MathUtils.lerp(175, 118, p);
      const camY = THREE.MathUtils.lerp(H * 0.62, H * 1.28, p) - pointer.y * 0.03 * 40;
      camera.position.set(
        worldOffset + Math.cos(az) * radius,
        camY,
        Math.sin(az) * radius,
      );
      camera.lookAt(worldOffset, THREE.MathUtils.lerp(H * 0.72, H * 0.95, p), 0);

      // clouds drift (×2 speed while scrubbing)
      for (const c of clouds) {
        c.angle += c.speed * dt * (1 + p);
        c.group.position.set(Math.cos(c.angle) * c.radius, c.y, Math.sin(c.angle) * c.radius);
      }

      // pennant flutter (vertex sin-wave)
      for (const f of flutterCloths) {
        const attr = f.mesh.geometry.attributes.position as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        for (let i = 0; i < attr.count; i++) {
          const bx = f.base[i * 3];
          arr[i * 3 + 2] = f.base[i * 3 + 2] + Math.sin(elapsed * 3.2 + f.phase + bx * 0.9) * 0.16 * bx;
        }
        attr.needsUpdate = true;
      }

      // pollen slow rise + sway
      const dp = dust.geometry.attributes.position as THREE.BufferAttribute;
      const darr = dp.array as Float32Array;
      for (let i = 0; i < DUST; i++) {
        darr[i * 3 + 1] += dt * 2.2;
        darr[i * 3] += Math.sin(elapsed * 0.6 + dustSeed[i]) * dt * 0.8;
        if (darr[i * 3 + 1] > H * 1.15) darr[i * 3 + 1] = 0;
      }
      dp.needsUpdate = true;

      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    /* ------------------------------ cleanup ------------------------------ */
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVis);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
          obj.geometry?.dispose();
          const mat = obj.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
          else mat?.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [scrollRef, failed]);

  if (failed) {
    // WebGL unavailable → static poster with slow Ken Burns drift
    return <HeroPoster />;
  }

  return <div ref={mountRef} className="absolute inset-0 animate-[fade-in_800ms_ease-out_both]" aria-hidden />;
}
