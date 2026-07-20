import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Warm paper card (design.md §8 `Card`): paper-deep bg, 2px ink/8 border,
 * radius 16–24, optional hover lift.
 */

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** enable hover lift -6px + slight tilt */
  hoverable?: boolean;
  /** corner radius: 16 (default) or 24 for hero cards/modals */
  radius?: 'md' | 'lg';
}

export default function Card({ children, hoverable = false, radius = 'md', className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'card-warm',
        hoverable && 'card-warm-hover cursor-pointer',
        radius === 'lg' ? 'rounded-3xl' : 'rounded-2xl',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
