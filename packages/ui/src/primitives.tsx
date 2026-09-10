import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

/* ----------------------------------------------------------- button */

const buttonVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-45 cursor-pointer select-none',
  {
    variants: {
      variant: {
        solid: 'bg-accent text-accent-ink hover:brightness-110 active:brightness-95',
        outline: 'border border-line bg-surface text-ink hover:bg-raised',
        ghost: 'text-ink-dim hover:text-ink hover:bg-raised',
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
  return <div className={cn('rounded-lg border border-line bg-surface', className)} {...props} />;
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
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        {hint ? <span className="text-[11px] text-ink-faint">{hint}</span> : null}
      </div>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------ badge */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium leading-4',
  {
    variants: {
      tone: {
        neutral: 'bg-raised text-ink-dim',
        ok: 'bg-ok/12 text-ok',
        err: 'bg-err/12 text-err',
        warn: 'bg-warn/12 text-warn',
        info: 'bg-info/12 text-info',
        accent: 'bg-accent-soft text-accent',
        inferred: 'border border-dashed border-inferred/60 text-inferred bg-transparent',
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
  return <TooltipPrimitive.Provider delayDuration={250}>{children}</TooltipPrimitive.Provider>;
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
          className="z-50 max-w-[340px] rounded-md border border-line bg-overlay px-2.5 py-1.5 text-[12px] leading-snug text-ink shadow-lg"
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
        'relative -mb-px rounded-t px-3 py-1.5 text-[12.5px] font-medium text-ink-dim transition-colors',
        'hover:text-ink data-[state=active]:text-ink',
        'data-[state=active]:border-b-2 data-[state=active]:border-accent',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent/50 cursor-pointer',
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
        className="flex w-2 touch-none select-none p-px"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line-strong" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        className="flex h-2 touch-none select-none p-px"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line-strong" />
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
        'placeholder:text-ink-faint outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
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
        'h-8 rounded-md border border-line bg-surface px-2 text-[12.5px] text-ink outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent/50 cursor-pointer',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/* --------------------------------------------------------- skeleton */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-raised', className)} />;
}

/* ------------------------------------------------------- empty state */

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-6 py-10 text-center',
        className,
      )}
    >
      {icon ? <div className="mb-1 text-ink-faint [&>svg]:size-6">{icon}</div> : null}
      <div className="text-[13px] font-medium text-ink-dim">{title}</div>
      {children ? <div className="max-w-[420px] text-[12px] text-ink-faint">{children}</div> : null}
    </div>
  );
}
