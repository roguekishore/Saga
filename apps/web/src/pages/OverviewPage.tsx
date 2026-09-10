import {
  AggValue,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  fmtInt,
  fmtMs,
  fmtTokens,
  InferredTag,
  KpiCard,
  NaValue,
  ProvenanceLegend,
  pct,
  Skeleton,
  StatusPill,
  timeAgo,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Radio } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { useLive } from '../lib/live-store';

const CACHE_NA =
  'No adapter in play produces cache token fields — on kiro-gateway nothing emits cache_read/cache_write (verified). n/a is the honest render, not 0.';
const COST_NA =
  'No per-token price table applies to this upstream. Kiro is a subscription with account rotation — per-token cost math against it is fiction, so SAGA refuses to invent a number.';

export function OverviewPage() {
  const { data: o, isLoading } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 5_000,
  });
  const rows = useLive((s) => s.rows);
  const live = rows.filter((r) => r.status === null);

  if (isLoading || !o) {
    return (
      <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders, no data identity
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {/* ------------------------------------------------------ KPI grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard
          label="active requests"
          value={o.activeRequests}
          tone={o.activeRequests > 0 ? 'accent' : undefined}
          sub={o.activeRequests > 0 ? 'streaming now' : 'idle'}
        />
        <KpiCard
          label={
            <span className="inline-flex items-center gap-1.5">
              active sessions <InferredTag what="session" />
            </span>
          }
          value={o.activeSessions}
          sub="last 5 minutes"
        />
        <KpiCard
          label="requests today"
          value={fmtInt(o.requestsToday)}
          spark={o.requestsSparkline.map((p) => ({ t: p.t, v: p.v }))}
        />
        <KpiCard
          label="output tokens today"
          value={<AggValue agg={o.tokensToday.output} className="text-[20px]" />}
          sub={<AggValue agg={o.tokensToday.input} render={(n) => `${fmtTokens(n)} in`} />}
          spark={o.outputTokensSparkline.map((p) => ({ t: p.t, v: p.v }))}
        />
        <KpiCard label="avg latency" value={fmtMs(o.avgLatencyMs)} sub="today, request time" />
        <KpiCard label="p95 latency" value={fmtMs(o.p95LatencyMs)} sub="today" />
        <KpiCard
          label="error rate"
          value={
            o.errorRateToday == null ? (
              <NaValue reason="No requests today." />
            ) : (
              pct(o.errorRateToday)
            )
          }
          tone={o.errorRateToday != null && o.errorRateToday > 0.05 ? 'err' : undefined}
          sub="upstream errors / requests"
        />
        <KpiCard
          label="cache hit ratio"
          value={o.cacheHitRatio == null ? <NaValue reason={CACHE_NA} /> : pct(o.cacheHitRatio)}
          sub={
            o.costToday == null ? (
              <span className="inline-flex items-center gap-1">
                cost: <NaValue reason={COST_NA} />
              </span>
            ) : (
              `cost ${o.costToday.value.toFixed(2)} ${o.costToday.currency}`
            )
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {/* ------------------------------------------------- live feed */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Live activity"
            hint="from the event stream"
            right={
              <Link to="/live" className="text-[11.5px] font-medium text-accent hover:underline">
                open monitor →
              </Link>
            }
          />
          <div className="px-1.5 pb-2">
            {rows.length === 0 ? (
              <EmptyState icon={<Radio />} title="No traffic seen yet" className="m-2 border-0">
                Point a client at the proxy — e.g.{' '}
                <code className="rounded bg-raised px-1 py-px font-mono text-[11px]">
                  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
                </code>{' '}
                — or replay the fixture corpus with{' '}
                <code className="rounded bg-raised px-1 py-px font-mono text-[11px]">
                  pnpm --filter @saga/corpus seed
                </code>
              </EmptyState>
            ) : (
              <ul>
                {rows.slice(0, 8).map((r) => (
                  <li key={r.requestId}>
                    <Link
                      to={`/requests/${r.requestId}`}
                      className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-raised/70"
                    >
                      <StatusPill status={r.status} className="w-20 shrink-0" />
                      <span className="w-40 truncate font-mono text-[12px] text-ink-dim">
                        {r.model ?? r.endpoint}
                      </span>
                      <span className="flex-1 truncate text-[12px] text-ink-faint">
                        {r.adapterId} · {r.messageCount} msgs
                        {r.toolUseCount > 0 ? ` · ${r.toolUseCount} tools` : ''}
                        {r.status === null && r.liveChars > 0
                          ? ` · ${fmtTokens(r.liveChars)} chars streamed`
                          : ''}
                      </span>
                      <span className="w-16 text-right font-mono text-[11.5px] text-ink-dim">
                        {fmtMs(r.latencyMs)}
                      </span>
                      <span className="w-16 text-right text-[11px] text-ink-faint">
                        {timeAgo(r.ts)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div className="space-y-3">
          {/* ------------------------------------------------ top models */}
          <Card>
            <CardHeader title="Top models" hint="today" />
            <div className="px-3.5 pb-3">
              {o.topModels.length === 0 ? (
                <div className="py-3 text-[12px] text-ink-faint">nothing yet today</div>
              ) : (
                o.topModels.map((m) => (
                  <div key={m.model} className="flex items-center justify-between gap-2 py-1">
                    <span className="truncate font-mono text-[12px]">{m.model}</span>
                    <span className="flex items-center gap-3 text-[12px] text-ink-dim">
                      <span>{fmtInt(m.requests)} req</span>
                      <AggValue agg={m.outputTokens} />
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* --------------------------------------------- recent errors */}
          <Card>
            <CardHeader title="Recent errors" />
            <div className="px-3.5 pb-3">
              {o.recentErrors.length === 0 ? (
                <div className="py-3 text-[12px] text-ink-faint">none — clean slate</div>
              ) : (
                o.recentErrors.map((e) => (
                  <Link
                    key={e.requestId}
                    to={`/requests/${e.requestId}`}
                    className="group flex items-start gap-2 py-1.5"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-err" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-ink group-hover:underline">
                        {e.message}
                      </span>
                      <span className="text-[11px] text-ink-faint">
                        {e.model ?? 'unknown model'} · {timeAgo(e.ts)}
                      </span>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </Card>

          {live.length > 0 ? (
            <Card className="border-info/30">
              <CardHeader title="In flight" right={<Badge tone="info">{live.length}</Badge>} />
              <div className="px-3.5 pb-3">
                {live.slice(0, 4).map((r) => (
                  <div
                    key={r.requestId}
                    className="flex justify-between py-0.5 font-mono text-[11.5px]"
                  >
                    <span className="truncate text-ink-dim">{r.model ?? r.endpoint}</span>
                    <span className="text-info">{fmtTokens(r.liveChars)} chars</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <ProvenanceLegend className="px-1 pt-1" />
    </div>
  );
}
