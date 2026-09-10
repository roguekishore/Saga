import type { ReactNode } from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { cn } from './cn';
import { Card } from './primitives';

/**
 * KPI cards rebuilt on our own primitives — Tremor is banned (pins React 18).
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
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 opacity-50">
          <Sparkline data={spark} />
        </div>
      ) : null}
    </Card>
  );
}

export function Sparkline({ data }: { data: Array<{ t: number; v: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="saga-spark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--saga-accent)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--saga-accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke="var(--saga-accent)"
          strokeWidth={1.25}
          fill="url(#saga-spark)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
