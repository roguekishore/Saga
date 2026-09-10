import {
  Card,
  CardHeader,
  EmptyState,
  fmtMs,
  fmtTokens,
  ProvenanceLegend,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AXIS,
  GridXY,
  SERIES_COLORS,
  TimeRangePicker,
  themedLegend,
  themedTooltip,
  timeTick,
  useTimeRange,
} from '../components/charts';
import { api } from '../lib/api';

export function AnalyticsPage() {
  const range = useTimeRange('7d');

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-ink-dim">
          Token and latency analytics over captured traffic. Every aggregate inherits the provenance
          of what the wire actually reported.
        </div>
        <TimeRangePicker value={range.key} onChange={range.setKey} />
      </div>

      <Tabs defaultValue="tokens">
        <TabsList>
          <TabsTrigger value="tokens">Tokens</TabsTrigger>
          <TabsTrigger value="latency">Latency</TabsTrigger>
        </TabsList>
        <TabsContent value="tokens" className="pt-3">
          <TokensTab from={range.from} to={range.to} bucket={range.bucket} />
        </TabsContent>
        <TabsContent value="latency" className="pt-3">
          <LatencyTab from={range.from} to={range.to} bucket={range.bucket} />
        </TabsContent>
      </Tabs>

      <ProvenanceLegend className="px-1" />
    </div>
  );
}

function TokensTab({ from, to, bucket }: { from: number; to: number; bucket: 'hour' | 'day' }) {
  const total = useQuery({
    queryKey: ['tok', from, to, bucket, 'none'],
    queryFn: () => api.tokenSeries({ from, to, bucket, groupBy: 'none' }),
  });
  const byModel = useQuery({
    queryKey: ['tok', from, to, bucket, 'model'],
    queryFn: () => api.tokenSeries({ from, to, bucket, groupBy: 'model' }),
  });

  const totalData = useMemo(
    () =>
      (total.data?.series ?? []).map((p) => ({
        t: p.t,
        input: p.input.value,
        output: p.output.value,
        requests: p.requests,
      })),
    [total.data],
  );

  const { modelData, models } = useMemo(() => {
    const byT = new Map<number, Record<string, number>>();
    const names = new Set<string>();
    for (const p of byModel.data?.series ?? []) {
      const key = p.group ?? '(none)';
      names.add(key);
      const row = byT.get(p.t) ?? {};
      row[key] = p.output.value;
      byT.set(p.t, row);
    }
    return {
      models: [...names].slice(0, 6),
      modelData: [...byT.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, vals]) => ({ t, ...vals })),
    };
  }, [byModel.data]);

  if (total.isLoading) return <Skeleton className="h-72" />;
  if (totalData.length === 0)
    return (
      <EmptyState title="No traffic in this range">
        Widen the range or send some requests.
      </EmptyState>
    );

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader title="Prompt vs completion tokens" hint="stacked, per bucket" />
        <div className="h-64 px-2 pb-2">
          <ResponsiveContainer>
            <AreaChart data={totalData}>
              <GridXY bucket={bucket} />
              {themedTooltip()}
              {themedLegend()}
              <Area
                dataKey="input"
                name="input"
                stackId="1"
                stroke="var(--saga-info)"
                fill="var(--saga-info)"
                fillOpacity={0.25}
                isAnimationActive={false}
              />
              <Area
                dataKey="output"
                name="output"
                stackId="1"
                stroke="var(--saga-accent)"
                fill="var(--saga-accent)"
                fillOpacity={0.35}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <CardHeader title="Output tokens by model" />
        <div className="h-64 px-2 pb-2">
          <ResponsiveContainer>
            <BarChart data={modelData}>
              <GridXY bucket={bucket} />
              {themedTooltip()}
              {themedLegend()}
              {models.map((m, i) => (
                <Bar
                  key={m}
                  dataKey={m}
                  stackId="m"
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader title="Requests per bucket" />
        <div className="h-40 px-2 pb-2">
          <ResponsiveContainer>
            <BarChart data={totalData}>
              <GridXY bucket={bucket} />
              {themedTooltip()}
              <Bar
                dataKey="requests"
                name="requests"
                fill="var(--saga-ink-faint)"
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}

function LatencyTab({ from, to, bucket }: { from: number; to: number; bucket: 'hour' | 'day' }) {
  const q = useQuery({
    queryKey: ['lat', from, to, bucket],
    queryFn: () => api.latencySeries({ from, to, bucket }),
  });

  if (q.isLoading) return <Skeleton className="h-72" />;
  const series = q.data?.series ?? [];
  const sample = q.data?.sample ?? [];
  if (series.length === 0) return <EmptyState title="No finished requests in this range" />;

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader title="Request latency" hint="avg · p50 · p95 per bucket" />
        <div className="h-64 px-2 pb-2">
          <ResponsiveContainer>
            <LineChart data={series}>
              <CartesianGrid stroke="var(--saga-line)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="t" {...AXIS} tickFormatter={timeTick(bucket)} minTickGap={28} />
              <YAxis {...AXIS} tickFormatter={(v: number) => fmtMs(v)} width={54} />
              {themedTooltip()}
              {themedLegend()}
              <Line
                dataKey="p95"
                name="p95"
                stroke="var(--saga-err)"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="p50"
                name="p50"
                stroke="var(--saga-accent)"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="avg"
                name="avg"
                stroke="var(--saga-info)"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <CardHeader title="Time to first token" hint="client-observed at the proxy" />
        <div className="h-64 px-2 pb-2">
          <ResponsiveContainer>
            <LineChart data={series}>
              <CartesianGrid stroke="var(--saga-line)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="t" {...AXIS} tickFormatter={timeTick(bucket)} minTickGap={28} />
              <YAxis {...AXIS} tickFormatter={(v: number) => fmtMs(v)} width={54} />
              {themedTooltip()}
              <Line
                dataKey="avgTtft"
                name="avg ttft"
                stroke="var(--saga-inferred)"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader
          title="Latency vs output size"
          hint={`${sample.length} most recent requests (downsampled)`}
        />
        <div className="h-64 px-2 pb-2">
          <ResponsiveContainer>
            <ScatterChart>
              <CartesianGrid stroke="var(--saga-line)" strokeDasharray="2 4" />
              <XAxis
                dataKey="outputTokens"
                name="output tokens"
                {...AXIS}
                tickFormatter={(v: number) => fmtTokens(v)}
                type="number"
              />
              <YAxis
                dataKey="latencyMs"
                name="latency"
                {...AXIS}
                tickFormatter={(v: number) => fmtMs(v)}
                width={54}
                type="number"
              />
              {themedTooltip()}
              <Scatter
                data={sample.filter((s) => s.outputTokens != null)}
                fill="var(--saga-accent)"
                fillOpacity={0.55}
                isAnimationActive={false}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
