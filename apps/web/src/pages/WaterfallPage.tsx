import {
  Card,
  CardHeader,
  cn,
  EmptyState,
  fmtMs,
  fmtTime,
  InferredTag,
  Select,
  Skeleton,
  StatusPill,
  Tip,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { FileClock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';

/**
 * Request Waterfall — honest spans only. A wrapper cannot see upstream
 * internals (queueing, memory injection, provider compute), so this renders
 * exactly what the proxy measured: sent → first content frame → stream end,
 * with in-stream tool_use marks (their timestamps ARE real capture times) and
 * inferred tool round-trips across requests.
 */
export function WaterfallPage() {
  const recent = useQuery({
    queryKey: ['requests-wf'],
    queryFn: () => api.requests({ limit: 100 }),
  });
  const items = (recent.data?.items ?? []).filter((i) => i.latencyMs != null);
  const [selectedId, setSelectedId] = useState('');
  const summary = items.find((i) => i.requestId === selectedId) ?? items[0];

  const detail = useQuery({
    queryKey: ['request', summary?.requestId],
    queryFn: () => api.requestDetail(summary!.requestId),
    enabled: !!summary,
  });
  const toolCalls = useQuery({
    queryKey: ['tool-calls-wf', summary?.requestId],
    queryFn: () => api.toolCalls({ requestId: summary!.requestId, limit: 50 }),
    enabled: !!summary,
  });

  const spans = useMemo(() => {
    const d = detail.data;
    if (!d) return null;
    const t = d.timeline;
    const end = t.finishedAt ?? t.firstTokenAt ?? t.sentAt;
    const total = Math.max(1, end - t.sentAt);
    const seg = (from: number, to: number) => ({
      leftPct: ((from - t.sentAt) / total) * 100,
      widthPct: Math.max(0.5, ((to - from) / total) * 100),
      ms: to - from,
    });
    return {
      total,
      wait: t.firstTokenAt ? seg(t.sentAt, t.firstTokenAt) : null,
      stream: t.firstTokenAt && t.finishedAt ? seg(t.firstTokenAt, t.finishedAt) : null,
      whole: seg(t.sentAt, end),
      sentAt: t.sentAt,
    };
  }, [detail.data]);

  if (recent.isLoading) return <Skeleton className="m-4 h-72" />;
  if (!summary) {
    return (
      <div className="p-6">
        <EmptyState icon={<FileClock />} title="No finished requests yet" />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={summary.requestId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="max-w-80 font-mono"
        >
          {items.map((i) => (
            <option key={i.requestId} value={i.requestId}>
              {fmtTime(i.ts)} · {i.model ?? i.endpoint} · {fmtMs(i.latencyMs)}{' '}
              {i.toolUseCount > 0 ? `· ${i.toolUseCount} tools` : ''}
            </option>
          ))}
        </Select>
        <StatusPill status={summary.status} />
        <Link
          to={`/requests/${summary.requestId}`}
          className="text-[12px] text-accent hover:underline"
        >
          open request →
        </Link>
        <span className="ml-auto text-[11.5px] text-ink-faint">
          Upstream internals are invisible from a wrapper — these spans are what SAGA measured.
        </span>
      </div>

      <Card>
        <CardHeader title="Request spans" hint="proxy-measured wall time" />
        <div className="space-y-2.5 px-3.5 pb-4">
          {!spans ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              <SpanRow
                label="request → first content frame"
                color="bg-info/70"
                leftPct={0}
                widthPct={spans.wait ? (spans.wait.ms / spans.total) * 100 : 100}
                ms={spans.wait?.ms ?? null}
              />
              {spans.stream ? (
                <SpanRow
                  label="content stream"
                  color="bg-accent/80"
                  leftPct={spans.stream.leftPct}
                  widthPct={spans.stream.widthPct}
                  ms={spans.stream.ms}
                />
              ) : null}
              <SpanRow
                label="total"
                color="bg-ink-faint/60"
                leftPct={0}
                widthPct={100}
                ms={spans.whole.ms}
              />
              {/* tool_use marks: real in-stream capture timestamps */}
              {(toolCalls.data ?? []).length > 0 && spans ? (
                <div className="relative mt-1 h-7 rounded bg-raised/60">
                  {(toolCalls.data ?? []).map((c) => {
                    const left = Math.min(
                      99,
                      Math.max(0, ((c.ts - spans.sentAt) / spans.total) * 100),
                    );
                    return (
                      <Tip
                        key={c.toolUseId}
                        content={`${c.name} — observed in-stream at +${fmtMs(c.ts - spans.sentAt)}`}
                      >
                        <div
                          className="absolute top-1 bottom-1 w-1 rounded bg-inferred"
                          style={{ left: `${left}%` }}
                        />
                      </Tip>
                    );
                  })}
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] text-ink-faint">
                    tool_use marks
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Tool round-trips in this session"
          hint="tool_use going out → tool_result coming back in a later request"
        />
        <SessionRoundTrips sessionId={summary.sessionId} />
      </Card>
    </div>
  );
}

function SpanRow({
  label,
  color,
  leftPct,
  widthPct,
  ms,
}: {
  label: string;
  color: string;
  leftPct: number;
  widthPct: number;
  ms: number | null;
}) {
  return (
    <div className="grid grid-cols-[210px_1fr_70px] items-center gap-3">
      <span className="text-[11.5px] text-ink-dim">{label}</span>
      <div className="relative h-4 overflow-hidden rounded bg-raised">
        <div
          className={cn('absolute top-0 h-full rounded', color)}
          style={{ left: `${leftPct}%`, width: `${Math.min(100 - leftPct, widthPct)}%` }}
        />
      </div>
      <span className="text-right font-mono text-[11.5px] tabular-nums">{fmtMs(ms)}</span>
    </div>
  );
}

function SessionRoundTrips({ sessionId }: { sessionId: string }) {
  const q = useQuery({
    queryKey: ['tool-calls-session', sessionId],
    queryFn: () => api.toolCalls({ sessionId, limit: 60 }),
  });
  const rows = (q.data ?? []).filter((c) => c.roundTripMs != null);
  if (q.isLoading) return <Skeleton className="m-3 h-24" />;
  if (rows.length === 0) {
    return (
      <div className="px-3.5 pb-3.5 text-[12px] text-ink-faint">
        No closed tool loops in this session — results either weren't sent back through the proxy or
        the loops are still open.
      </div>
    );
  }
  const max = Math.max(...rows.map((c) => c.roundTripMs!));
  return (
    <div className="space-y-1.5 px-3.5 pb-4">
      {rows.map((c) => (
        <div
          key={`${c.requestId}-${c.toolUseId}`}
          className="grid grid-cols-[150px_1fr_110px] items-center gap-3"
        >
          <span className="truncate font-mono text-[11.5px]">{c.name}</span>
          <div className="h-3 overflow-hidden rounded bg-raised">
            <div
              className="h-full rounded bg-inferred/70"
              style={{ width: `${Math.max(2, (c.roundTripMs! / max) * 100)}%` }}
            />
          </div>
          <span className="flex items-center justify-end gap-1.5 font-mono text-[11.5px] tabular-nums text-ink-dim">
            {fmtMs(c.roundTripMs)} <InferredTag what="tool-round-trip" />
          </span>
        </div>
      ))}
    </div>
  );
}
