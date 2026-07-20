/**
 * Engine — Three.js renderer/scene/camera shell for the game page
 * (design.md §2.2 world mood, §12 performance guardrails).
 *
 *  - one WebGL context, fully disposed on unmount
 *  - DPR caps: 2 desktop / 1.5 mobile; quality presets scale DPR + instances
 *  - warm golden-hour light rig: 1 directional sun + 1 hemisphere fill
 *  - gradient sky dome (zenith #8FB9CE → horizon #F6DDBB) + warm fog
 *  - altitude mood: fog lerps cooler as the player climbs
 */

import * as THREE from 'three';
import type { QualityLevel } from '@/lib/db';

export type ResolvedQuality = 'low' | 'medium' | 'high';

export interface QualityPreset {
  dprCap: number;
  trees: number;
  rocks: number;
  cloudClusters: number;
  birds: number;
}

export const QUALITY_PRESETS: Record<ResolvedQuality, QualityPreset> = {
  low: { dprCap: 1, trees: 70, rocks: 45, cloudClusters: 5, birds: 2 },
  medium: { dprCap: 1.5, trees: 105, rocks: 68, cloudClusters: 8, birds: 3 },
  high: { dprCap: 2, trees: 140, rocks: 90, cloudClusters: 10, birds: 3 },
};

/** `auto` heuristic (design.md §12): device memory/cores + form factor. */
export function resolveQuality(q: QualityLevel, isMobile: boolean): ResolvedQuality {
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency ?? 8;
  if (isMobile) return mem <= 4 || cores <= 6 ? 'low' : 'medium';
  return mem <= 4 || cores <= 4 ? 'medium' : 'high';
}

const SKY_ZENITH = new THREE.Color('#8FB9CE');
const SKY_HORIZON = new THREE.Color('#F6DDBB');
const SKY_ZENITH_COLD = new THREE.Color('#7FA8C8');
const SKY_HORIZON_COLD = new THREE.Color('#E4D9C8');
const FOG_WARM = new THREE.Color('#E9D7BC');
const FOG_COLD = new THREE.Color('#D5DFE8');

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
varying vec3 vDir;
void main() {
  float t = clamp(normalize(vDir).y * 1.55 + 0.14, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(t, 0.82));
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface EngineOptions {
  quality: ResolvedQuality;
  isMobile: boolean;
  onContextLost: () => void;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private skyMat: THREE.ShaderMaterial;
  private skyGeo: THREE.SphereGeometry;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.Fog;
  private isMobile: boolean;
  private quality: ResolvedQuality;
  private onResize = () => this.resize();
  private onLost: (e: Event) => void;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.canvas = canvas;
    this.isMobile = opts.isMobile;
    this.quality = opts.quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !opts.isMobile,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene = new THREE.Scene();
    this.fog = new THREE.Fog(FOG_WARM.clone(), 60, 260);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 600);
    this.camera.rotation.order = 'YXZ';

    // Gradient sky dome (fog-exempt).
    this.skyGeo = new THREE.SphereGeometry(480, 24, 14);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uZenith: { value: SKY_ZENITH.clone() },
        uHorizon: { value: SKY_HORIZON.clone() },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const sky = new THREE.Mesh(this.skyGeo, this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.scene.add(sky);

    // Warm golden-hour rig: single directional sun + hemisphere fill (§12).
    this.sun = new THREE.DirectionalLight('#FFE3B3', 2.6);
    this.sun.position.set(-140, 105, -80);
    this.scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight('#BFD3DC', '#C9AE86', 1.15);
    this.scene.add(this.hemi);

    this.applyDpr();
    this.resize();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);

    this.onLost = (e) => {
      e.preventDefault();
      opts.onContextLost();
    };
    canvas.addEventListener('webglcontextlost', this.onLost, false);
  }

  private applyDpr(): void {
    const preset = QUALITY_PRESETS[this.quality];
    const hardCap = this.isMobile ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.dprCap, hardCap));
  }

  /** Quality changes apply to DPR immediately; instance counts apply on next world gen. */
  setQuality(q: ResolvedQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.applyDpr();
    this.resize();
  }

  get preset(): QualityPreset {
    return QUALITY_PRESETS[this.quality];
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** Altitude mood shift (game.md §3): fog + sky lerp cooler as frac goes 0→1. */
  setAltitudeMood(frac: number): void {
    const t = THREE.MathUtils.clamp(frac, 0, 1);
    this.fog.color.lerpColors(FOG_WARM, FOG_COLD, t * 0.7);
    this.fog.far = THREE.MathUtils.lerp(260, 232, t);
    (this.skyMat.uniforms.uZenith.value as THREE.Color).lerpColors(SKY_ZENITH, SKY_ZENITH_COLD, t * 0.6);
    (this.skyMat.uniforms.uHorizon.value as THREE.Color).lerpColors(SKY_HORIZON, SKY_HORIZON_COLD, t * 0.6);
  }

  render(): void {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.skyGeo.dispose();
    this.skyMat.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.renderer.dispose();
  }
}
