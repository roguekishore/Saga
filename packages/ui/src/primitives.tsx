import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

/*
 * Primitive vocabulary. Focus states come from the global :focus-visible
 * ring; nothing here sets outline-none. All transitions ride the --dur-*
 * scale so reduced motion collapses them structurally.
 */

/* ----------------------------------------------------------- button */

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium',
    'cursor-pointer select-none transition-[background-color,border-color,color,filter,transform]',
    'duration-(--dur-1) active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45',
  ].join(' '),
  {
    variants: {
      variant: {
        solid: 'bg-accent text-accent-ink hover:brightness-[1.08] active:brightness-95',
        outline: 'border border-line bg-surface text-ink hover:border-line-strong hover:bg-raised',
        ghost: 'text-ink-dim hover:bg-raised hover:text-ink',
        danger: 'border border-err/40 text-err hover:bg-err/10',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3 text-[13px]',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

/* ------------------------------------------------------------- card */

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-[10px] border border-line bg-surface shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  hint,
  right,
  className,
}: {
  title: ReactNode;
  hint?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2 px-3.5 pt-3 pb-1.5', className)}>
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="truncate text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        {hint ? <span className="truncate text-[11px] text-ink-faint">{hint}</span> : null}
      </div>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------ badge */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[5px] px-1.5 py-px text-[10.5px] font-medium leading-4',
  {
    variants: {
      tone: {
        neutral: 'bg-raised text-ink-dim',
        ok: 'bg-ok/12 text-ok',
        err: 'bg-err/12 text-err',
        warn: 'bg-warn/14 text-warn',
        info: 'bg-info/12 text-info',
        accent: 'bg-accent-soft text-accent',
        inferred: 'border border-dashed border-inferred/60 bg-transparent text-inferred',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ---------------------------------------------------------- tooltip */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={180} skipDelayDuration={250}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-[360px] rounded-lg border border-line bg-overlay px-3 py-2',
            'text-[12px] leading-snug text-ink shadow-float',
            'animate-[saga-scale-in_var(--dur-2)_var(--ease-out)]',
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ------------------------------------------------------------- tabs */

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex items-center gap-1 border-b border-line px-1', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative -mb-px cursor-pointer rounded-t px-3 py-1.5 text-[12.5px] font-medium',
        'text-ink-dim transition-colors duration-(--dur-1) hover:text-ink',
        'data-[state=active]:text-ink',
        // the underline: an animated rail rather than a border swap
        'after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full',
        'after:bg-accent after:opacity-0 after:transition-[opacity,transform]',
        'after:duration-(--dur-2) after:ease-(--ease-out) after:scale-x-50',
        'data-[state=active]:after:scale-x-100 data-[state=active]:after:opacity-100',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('outline-none', className)} {...props} />;
}

/* -------------------------------------------------------- scrollarea */

export function ScrollArea({
  className,
  children,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root className={cn('overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport className="size-full [&>div]:!block">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-1.5 touch-none select-none p-px"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line-strong transition-colors duration-(--dur-1) hover:bg-ink-faint" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        className="flex h-1.5 touch-none select-none p-px"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line-strong transition-colors duration-(--dur-1) hover:bg-ink-faint" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

/* ------------------------------------------------------------ input */

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink',
        'transition-colors duration-(--dur-1) placeholder:text-ink-faint',
        'hover:border-line-strong focus:border-line-strong',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 cursor-pointer rounded-md border border-line bg-surface px-2 text-[12.5px] text-ink',
        'transition-colors duration-(--dur-1) hover:border-line-strong',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/* -------------------------------------------------------- segmented */

/** Compact mutually-exclusive choice group (time ranges, view modes). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-0.5 rounded-md bg-raised p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'cursor-pointer rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium',
            'transition-[background-color,color,box-shadow] duration-(--dur-1)',
            o.value === value
              ? 'bg-surface text-ink shadow-card'
              : 'text-ink-dim hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- kbd */

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded border border-line',
        'bg-raised px-1 font-mono text-[10px] leading-none text-ink-dim',
        className,
      )}
      {...props}
    />
  );
}

/* --------------------------------------------------------- skeleton */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-raised', className)}>
      <div
        className={cn(
          'absolute inset-0 -translate-x-full',
          'bg-gradient-to-r from-transparent via-ink/6 to-transparent',
          'animate-[saga-shimmer_1.6s_var(--ease-in-out)_infinite]',
          'motion-reduce:animate-none',
        )}
      />
    </div>
  );
}

/* ------------------------------------------------------- empty state */

export function EmptyState({
  icon,
  title,
  action,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed',
        'border-line px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? (
        <div className="mb-1 flex size-10 items-center justify-center rounded-full border border-line bg-raised/60 text-ink-faint [&>svg]:size-5">
          {icon}
        </div>
      ) : null}
      <div className="text-[13px] font-medium text-ink-dim">{title}</div>
      {children ? (
        <div className="max-w-[440px] text-[12px] leading-5 text-ink-faint">{children}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
