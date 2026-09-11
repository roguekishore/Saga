import { fmtTokens, Segmented } from '@saga/ui';
import { useState } from 'react';
import { CartesianGrid, Tooltip as ChartTooltip, Legend, XAxis, YAxis } from 'recharts';

/** Shared Recharts theming + the time-range control. */

export const AXIS = {
  stroke: 'var(--saga-line-strong)',
  tick: { fill: 'var(--saga-ink-faint)', fontSize: 10.5, fontFamily: 'var(--font-mono)' },
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
      cursor={{ stroke: 'var(--saga-line-strong)', strokeDasharray: '3 3' }}
      contentStyle={{
        background: 'var(--saga-overlay)',
        border: '1px solid var(--saga-line)',
        borderRadius: 10,
        boxShadow: 'var(--saga-shadow-lg)',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        color: 'var(--saga-ink)',
      }}
      labelStyle={{ color: 'var(--saga-ink-dim)', fontFamily: 'var(--font-sans)' }}
      labelFormatter={(t) => (typeof t === 'number' ? new Date(t).toLocaleString() : String(t))}
      isAnimationActive={false}
    />
  );
}

export function themedLegend() {
  return (
    <Legend
      wrapperStyle={{ fontSize: 11.5, color: 'var(--saga-ink-dim)' }}
      iconType="plainline"
      iconSize={10}
    />
  );
}

/**
 * Categorical series — fixed slot order, never cycled or re-ranked (a filter
 * that changes the series count must not repaint the survivors). Validated
 * for CVD separation in both themes; see packages/ui/DESIGN.md.
 */
export const SERIES_COLORS = [
  'var(--saga-cat-1)',
  'var(--saga-cat-2)',
  'var(--saga-cat-3)',
  'var(--saga-cat-4)',
  'var(--saga-cat-5)',
  'var(--saga-cat-6)',
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
    <Segmented
      aria-label="time range"
      value={value}
      onChange={onChange}
      options={(Object.keys(RANGES) as RangeKey[]).map((k) => ({
        value: k,
        label: RANGES[k].label,
      }))}
      className={className}
    />
  );
}
