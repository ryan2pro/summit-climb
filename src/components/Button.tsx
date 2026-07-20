import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Chunky pill button with hard-shadow press effect (design.md §8 `Button`).
 * Variants: primary (terracotta) · secondary (paper-deep, ink outline) ·
 * ghost · danger.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** render as a router link */
  to?: string;
  href?: string;
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-terracotta text-snow border-2 border-ink hover:bg-terracotta-deep',
  secondary: 'bg-paper-deep text-ink border-2 border-ink hover:bg-line',
  ghost: 'bg-transparent text-ink border-2 border-transparent hover:bg-ink/5',
  danger: 'bg-danger text-snow border-2 border-ink hover:bg-terracotta-deep',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-11 px-5 text-sm',
  md: 'h-[52px] px-7 text-base',
  lg: 'h-16 px-9 text-lg',
  xl: 'h-16 px-12 text-xl',
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', to, href, className, children, ...rest },
  ref,
) {
  const classes = cn(
    'btn-hard inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-btn font-semibold tracking-wide',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta',
    'disabled:pointer-events-none disabled:opacity-50',
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
  if (to) {
    return (
      <Link to={to} className={classes}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }
  return (
    <button ref={ref} className={classes} {...rest}>
      {children}
    </button>
  );
});

export default Button;
