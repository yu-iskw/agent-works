import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'icon' | 'icon-sm';

const baseClass =
  'inline-flex shrink-0 items-center justify-center text-sm font-medium whitespace-nowrap transition duration-150 ease-out outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size: ButtonSize;
  readonly round?: boolean;
};

export function Button({
  variant = 'primary',
  size,
  round = false,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, round, className)} {...props} />;
}

function buttonClass(
  variant: ButtonVariant,
  size: ButtonSize,
  round: boolean,
  className: string | undefined,
): string {
  return [
    baseClass,
    round ? 'rounded-full' : 'rounded-lg',
    variantClass(variant),
    sizeClass(size),
    className,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

function variantClass(variant: ButtonVariant): string {
  switch (variant) {
    case 'primary':
      return 'bg-primary text-primary-foreground hover:bg-primary/80';
    case 'secondary':
      return 'bg-secondary text-secondary-foreground hover:bg-secondary/80';
    case 'ghost':
      return 'hover:bg-muted';
    default: {
      const unhandled: never = variant;
      return unhandled;
    }
  }
}

function sizeClass(size: ButtonSize): string {
  switch (size) {
    case 'sm':
      return 'h-7 gap-1 px-2.5 text-[0.8rem]';
    case 'icon':
      return 'size-8';
    case 'icon-sm':
      return 'size-7';
    default: {
      const unhandled: never = size;
      return unhandled;
    }
  }
}
