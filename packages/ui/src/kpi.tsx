import type { ReactNode } from 'react';
import { cn } from './cn';
import { Card } from './primitives';

/**
 * KPI cards on our own primitives. The sparkline is hand-rolled SVG — a
 * polyline needs no charting runtime, and keeping this package free of chart
 * dependencies is what keeps charts out of the shell's initial chunk.
 */
export function KpiCard({
  label,
  value,
  sub,
  spark,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  spark?: Array<{ t: number; v: number }>;
  tone?: 'ok' | 'err' | 'warn' | 'accent';
  className?: string;
}) {
  return (
    <Card className={cn('relative overflow-hidden px-3.5 py-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">
          {label}
        </div>
      </div>
      <div
        className={cn(
          'mt-1 font-semibold tabular-nums tracking-tight text-[22px] leading-7 text-ink',
          tone === 'ok' && 'text-ok',
          tone === 'err' && 'text-err',
          tone === 'warn' && 'text-warn',
          tone === 'accent' && 'text-accent',
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[11.5px] text-ink-dim">{sub}</div> : null}
      {spark && spark.length > 1 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 opacity-60">
          <Sparkline data={spark} />
        </div>
      ) : null}
    </Card>
  );
}

export function Sparkline({
  data,
  className,
}: {
  data: Array<{ t: number; v: number }>;
  className?: string;
}) {
  if (data.length < 2) return null;
  const w = 100;
  const h = 32;
  const vs = data.map((d) => d.v);
  const min = Math.min(...vs);
  const span = Math.max(...vs) - min || 1;
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 2 - ((d.v - min) / span) * (h - 6);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p}`).join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn('size-full', className)}
    >
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill="var(--saga-accent)" opacity={0.12} />
      <path
        d={line}
        fill="none"
        stroke="var(--saga-accent)"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
      />
    </svg>
  );
}
