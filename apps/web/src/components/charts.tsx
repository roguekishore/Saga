import { Button, cn, fmtTokens } from '@saga/ui';
import { useState } from 'react';
import { CartesianGrid, Tooltip as ChartTooltip, Legend, XAxis, YAxis } from 'recharts';

/** Shared Recharts theming + a small time-range control. */

export const AXIS = {
  stroke: 'var(--saga-line-strong)',
  tick: { fill: 'var(--saga-ink-faint)', fontSize: 10.5 },
  tickLine: false as const,
  axisLine: false as const,
};

export function timeTick(bucket: 'hour' | 'day'): (t: number) => string {
  return (t: number) => {
    const d = new Date(t);
    if (bucket === 'hour') return `${String(d.getHours()).padStart(2, '0')}:00`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
}

export function GridXY({ bucket }: { bucket: 'hour' | 'day' }) {
  return (
    <>
      <CartesianGrid stroke="var(--saga-line)" strokeDasharray="2 4" vertical={false} />
      <XAxis dataKey="t" {...AXIS} tickFormatter={timeTick(bucket)} minTickGap={28} />
      <YAxis {...AXIS} tickFormatter={(v: number) => fmtTokens(v)} width={44} />
    </>
  );
}

export function themedTooltip() {
  return (
    <ChartTooltip
      contentStyle={{
        background: 'var(--saga-overlay)',
        border: '1px solid var(--saga-line)',
        borderRadius: 8,
        fontSize: 12,
        color: 'var(--saga-ink)',
      }}
      labelStyle={{ color: 'var(--saga-ink-dim)' }}
      labelFormatter={(t) => (typeof t === 'number' ? new Date(t).toLocaleString() : String(t))}
      isAnimationActive={false}
    />
  );
}

export function themedLegend() {
  return <Legend wrapperStyle={{ fontSize: 11.5, color: 'var(--saga-ink-dim)' }} />;
}

export const SERIES_COLORS = [
  'var(--saga-accent)',
  'var(--saga-info)',
  'var(--saga-ok)',
  'var(--saga-inferred)',
  'var(--saga-err)',
  'var(--saga-prov-saga)',
];

const DAY = 86_400_000;
export type RangeKey = '24h' | '7d' | '30d' | '90d' | '1y';
const RANGES: Record<RangeKey, { ms: number; bucket: 'hour' | 'day'; label: string }> = {
  '24h': { ms: DAY, bucket: 'hour', label: '24h' },
  '7d': { ms: 7 * DAY, bucket: 'hour', label: '7d' },
  '30d': { ms: 30 * DAY, bucket: 'day', label: '30d' },
  '90d': { ms: 90 * DAY, bucket: 'day', label: '90d' },
  '1y': { ms: 365 * DAY, bucket: 'day', label: '1y' },
};

export function useTimeRange(initial: RangeKey = '7d') {
  const [key, setKey] = useState<RangeKey>(initial);
  const r = RANGES[key];
  const to = Date.now();
  return { key, setKey, from: to - r.ms, to, bucket: r.bucket };
}

export function TimeRangePicker({
  value,
  onChange,
  className,
}: {
  value: RangeKey;
  onChange: (k: RangeKey) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      {(Object.keys(RANGES) as RangeKey[]).map((k) => (
        <Button
          key={k}
          variant={k === value ? 'solid' : 'ghost'}
          size="sm"
          onClick={() => onChange(k)}
        >
          {RANGES[k].label}
        </Button>
      ))}
    </div>
  );
}
