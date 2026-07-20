import { cn } from '@/lib/utils';

/**
 * PlayerChip (design.md §8): avatar color dot + name + optional 房主 badge /
 * altitude / ping. Used in the lobby player list and the game HUD.
 */

export interface PlayerChipProps {
  name: string;
  color: string;
  isHost?: boolean;
  /** current altitude in meters (game HUD) */
  altitude?: number;
  /** latency in ms */
  ping?: number;
  /** "我" marker for the local player */
  isSelf?: boolean;
  size?: 'sm' | 'md';
  dark?: boolean;
  className?: string;
}

export default function PlayerChip({
  name,
  color,
  isHost = false,
  altitude,
  ping,
  isSelf = false,
  size = 'md',
  dark = false,
  className,
}: PlayerChipProps) {
  const dot = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border-2 px-3 py-1.5',
        dark ? 'hud-glass border-transparent text-snow' : 'border-ink/15 bg-snow/70 text-ink',
        size === 'sm' ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      <span
        className={cn('shrink-0 rounded-full border-2 border-ink/60', dot)}
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="max-w-[8rem] truncate font-bold">
        {name}
        {isSelf && <span className={cn('ml-1 font-medium', dark ? 'text-snow/60' : 'text-ink-soft')}>（我）</span>}
      </span>
      {isHost && (
        <span className="rounded-full bg-amber px-2 py-0.5 text-[0.65rem] font-bold leading-none text-ink">
          房主
        </span>
      )}
      {typeof altitude === 'number' && (
        <span className={cn('font-mono text-xs', dark ? 'text-amber' : 'text-ink-soft')}>
          {Math.round(altitude)}m
        </span>
      )}
      {typeof ping === 'number' && (
        <span
          className={cn(
            'font-mono text-xs',
            ping < 80 ? 'text-sage' : ping < 160 ? 'text-amber' : 'text-danger',
          )}
          title="延迟"
        >
          {Math.round(ping)}ms
        </span>
      )}
    </div>
  );
}
