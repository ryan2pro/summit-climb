/**
 * Static hero poster (/hero-fallback.svg) with a slow Ken Burns drift.
 * Three.js-free, so it can be used as the Suspense fallback while the
 * code-split HeroMountain chunk loads; HeroMountain also renders it when
 * WebGL is unavailable (design.md §12).
 */
export default function HeroPoster() {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <img src="/hero-fallback.svg" alt="" className="h-full w-full animate-kenburns object-cover" />
    </div>
  );
}
