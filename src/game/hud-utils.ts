/**
 * HUD display helpers — pure formatting constants/functions shared by the
 * HUD widgets. Kept in a component-free module so hud.tsx satisfies
 * react-refresh/only-export-components.
 */

export const COSMETIC_ZH: Record<string, string> = {
  beanie: '毛线帽',
  bandana: '头巾',
  goggles: '雪镜',
  carabiner: '金色快挂',
  champion: '冠军旗纹',
};

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function formatTimeCs(ms: number): string {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}
