import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { cn } from '@/lib/utils';

/**
 * ClimberPreview (lobby.md 我的名片): small lightweight three.js canvas
 * rendering the low-poly capsule climber in the selected color wearing the
 * selected cosmetic. Slow turntable (0.6 rad/s) + drag-to-rotate.
 *
 * - One WebGL context, fully disposed on unmount (design.md §12).
 * - Falls back to a CSS capsule figure if WebGL is unavailable.
 */

const SKIN = '#F2D8B8';
const PACK = '#8A6B4E';
const COSMETIC_IDS = ['beanie', 'bandana', 'goggles', 'carabiner', 'champion'] as const;

interface PreviewHandle {
  setColor: (color: string) => void;
  setCosmetic: (cosmetic: string) => void;
}

interface ClimberBuild {
  group: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  parts: Record<string, THREE.Object3D>;
  dispose: () => void;
}

/** Build the low-poly climber: capsule body + head + backpack + cosmetics. */
function buildClimber(color: string): ClimberBuild {
  const group = new THREE.Group();
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const track = <T extends THREE.BufferGeometry>(geo: T): T => {
    geoms.push(geo);
    return geo;
  };
  const std = (c: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color: c,
      flatShading: true,
      roughness: 1,
      metalness: 0,
      ...extra,
    });
    mats.push(m);
    return m;
  };
  const add = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
  ): THREE.Mesh => {
    const me = new THREE.Mesh(geo, mat);
    me.position.set(x, y, z);
    parent.add(me);
    return me;
  };

  // body capsule in player color
  const bodyMat = std(color);
  add(group, track(new THREE.CapsuleGeometry(0.34, 0.62, 4, 10)), bodyMat, 0, 0.86, 0);
  // head
  add(group, track(new THREE.SphereGeometry(0.27, 10, 8)), std(SKIN), 0, 1.56, 0);
  // eyes
  const eyeMat = std('#2E2418');
  add(group, track(new THREE.SphereGeometry(0.035, 6, 5)), eyeMat, -0.1, 1.58, 0.24);
  add(group, track(new THREE.SphereGeometry(0.035, 6, 5)), eyeMat, 0.1, 1.58, 0.24);
  // mini backpack
  add(group, track(new THREE.BoxGeometry(0.42, 0.52, 0.2)), std(PACK), 0, 0.98, -0.34);

  const parts: Record<string, THREE.Object3D> = {};

  // 毛线帽 beanie — cap + folded brim + pom
  {
    const g = new THREE.Group();
    add(
      g,
      track(new THREE.SphereGeometry(0.29, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.1)),
      std('#B25A30'),
      0,
      1.6,
      0,
    );
    const brim = add(g, track(new THREE.TorusGeometry(0.26, 0.065, 6, 14)), std('#8F4526'), 0, 1.61, 0);
    brim.rotation.x = Math.PI / 2;
    add(g, track(new THREE.SphereGeometry(0.09, 7, 6)), std('#F6F2E9'), 0, 1.88, 0);
    parts.beanie = g;
  }
  // 头巾 bandana — brow band + knot
  {
    const g = new THREE.Group();
    const band = add(g, track(new THREE.TorusGeometry(0.275, 0.055, 6, 14)), std('#C85F6E'), 0, 1.63, 0);
    band.rotation.x = Math.PI / 2;
    add(g, track(new THREE.BoxGeometry(0.1, 0.14, 0.05)), std('#C85F6E'), 0, 1.6, -0.28);
    parts.bandana = g;
  }
  // 雪镜 goggles — strap + amber lens
  {
    const g = new THREE.Group();
    const strap = add(g, track(new THREE.TorusGeometry(0.275, 0.04, 6, 14)), std('#2E2418'), 0, 1.58, 0);
    strap.rotation.x = Math.PI / 2;
    add(g, track(new THREE.BoxGeometry(0.34, 0.12, 0.08)), std('#E8A94C', { roughness: 0.4 }), 0, 1.58, 0.24);
    parts.goggles = g;
  }
  // 金色快挂 golden carabiner — back bling
  {
    const g = new THREE.Group();
    const ring = add(
      g,
      track(new THREE.TorusGeometry(0.09, 0.028, 6, 12)),
      std('#E8A94C', { metalness: 0.6, roughness: 0.35 }),
      0.28,
      0.92,
      -0.34,
    );
    ring.rotation.y = Math.PI / 2.4;
    parts.carabiner = g;
  }
  // 冠军旗纹 champion — little pennant on the backpack
  {
    const g = new THREE.Group();
    add(g, track(new THREE.CylinderGeometry(0.018, 0.018, 0.56, 6)), std(PACK), 0.14, 1.36, -0.38);
    add(g, track(new THREE.BoxGeometry(0.3, 0.18, 0.02)), std('#D0713F'), 0.3, 1.56, -0.38);
    add(g, track(new THREE.BoxGeometry(0.3, 0.05, 0.024)), std('#F6F2E9'), 0.3, 1.56, -0.38);
    parts.champion = g;
  }

  for (const id of COSMETIC_IDS) {
    parts[id].visible = id === 'beanie';
    group.add(parts[id]);
  }

  return {
    group,
    bodyMat,
    parts,
    dispose: () => {
      for (const geo of geoms) geo.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

export interface ClimberPreviewProps {
  color: string;
  cosmetic: string;
  className?: string;
}

export default function ClimberPreview({ color, cosmetic, className }: ClimberPreviewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<PreviewHandle | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      setFailed(true);
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    camera.position.set(0, 1.35, 3.6);
    camera.lookAt(0, 0.95, 0);

    const hemi = new THREE.HemisphereLight('#BFD3DC', '#C9AE86', 1.0);
    const sun = new THREE.DirectionalLight('#FFE3B3', 2.2);
    sun.position.set(3, 5, 4);
    scene.add(hemi, sun);

    // ground disc + soft blob shadow
    const discGeo = new THREE.CircleGeometry(1.15, 28);
    const discMat = new THREE.MeshStandardMaterial({ color: '#E0D0AC', roughness: 1, metalness: 0 });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    const shadowGeo = new THREE.CircleGeometry(0.55, 20);
    const shadowMat = new THREE.MeshBasicMaterial({ color: '#2E2418', transparent: true, opacity: 0.12 });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    scene.add(disc, shadow);

    const climber = buildClimber(color);
    for (const id of COSMETIC_IDS) climber.parts[id].visible = id === cosmetic;
    scene.add(climber.group);

    handleRef.current = {
      setColor: (c: string) => climber.bodyMat.color.set(c),
      setCosmetic: (c: string) => {
        for (const id of COSMETIC_IDS) climber.parts[id].visible = id === c;
      },
    };

    // turntable + drag-to-rotate
    let autoAngle = 0;
    let userAngle = 0;
    let dragging = false;
    let lastX = 0;
    let lastDragEnd = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      userAngle += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      lastDragEnd = performance.now();
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (!dragging && performance.now() - lastDragEnd > 1200) {
        autoAngle += dt * 0.6; // slow turntable 0.6 rad/s
      }
      climber.group.rotation.y = autoAngle + userAngle;
      climber.group.position.y = Math.sin(clock.elapsedTime * 1.4) * 0.02;
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      handleRef.current = null;
      scene.remove(climber.group);
      climber.dispose();
      discGeo.dispose();
      discMat.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      hemi.dispose();
      sun.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scene is created once per mount; live updates flow through handleRef
  }, []);

  useEffect(() => {
    handleRef.current?.setColor(color);
  }, [color]);
  useEffect(() => {
    handleRef.current?.setCosmetic(cosmetic);
  }, [cosmetic]);

  return (
    <div ref={wrapRef} className={cn('relative h-[200px] w-full overflow-hidden', className)}>
      {failed ? (
        /* CSS capsule fallback when WebGL is unavailable (design.md §12) */
        <div className="flex h-full items-end justify-center pb-5" aria-hidden>
          <div
            className="relative h-24 w-14 rounded-full border-2 border-ink/60 transition-colors"
            style={{ backgroundColor: color }}
          >
            <div className="absolute -top-8 left-1/2 h-10 w-10 -translate-x-1/2 rounded-full border-2 border-ink/60 bg-[#F2D8B8]" />
            <div className="absolute -top-9 left-1/2 h-4 w-11 -translate-x-1/2 rounded-t-full border-2 border-ink/60 bg-terracotta-deep" />
          </div>
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: 'grab' }}
          aria-label="攀登者 3D 预览"
        />
      )}
    </div>
  );
}
