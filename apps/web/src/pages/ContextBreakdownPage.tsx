import type { ContentBlock, NormalizedMessage, RequestDetail } from '@saga/contracts';
import {
  Badge,
  Card,
  CardHeader,
  cn,
  EmptyState,
  fmtBytes,
  fmtTokens,
  ProvenanceDot,
  Skeleton,
  shortId,
  Tip,
  TokenValue,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../lib/api';

const Treemap = lazy(() => import('../components/ContextTreemap'));

/**
 * Context Breakdown: why is this prompt large? Byte numbers are REAL
 * (redacted payload bytes). Token-level splits per segment do not exist on
 * the wire — the only honest per-segment token figure is a SAGA estimate,
 * and it is labeled as exactly that.
 */

const SEGMENT_COLORS: Record<string, string> = {
  system: 'var(--saga-warn)',
  history: 'var(--saga-info)',
  user: 'var(--saga-ok)',
  tool: 'var(--saga-inferred)',
  spec: 'var(--saga-prov-saga)',
  memory: 'var(--saga-thinking)',
  unknown: 'var(--saga-ink-faint)',
};

function blockChars(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return b.text.length;
    case 'thinking':
      return b.thinking.length;
    case 'tool_use':
      return (b.inputJson ?? '').length + b.name.length;
    case 'tool_result':
      return b.content.reduce((a, c) => a + (c.type === 'text' ? c.text.length : 40), 0);
    case 'unknown':
      return b.json.length;
    case 'redacted_thinking':
      return b.data.length;
    case 'image':
      return 0;
  }
}

function messageChars(m: NormalizedMessage): number {
  return m.blocks.reduce((a, b) => a + blockChars(b), 0);
}

export function ContextBreakdownPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['request', id], queryFn: () => api.requestDetail(id) });

  if (q.isLoading) return <Skeleton className="m-4 h-80" />;
  if (!q.data) return <EmptyState className="m-6" title="Request not found" />;
  const d: RequestDetail = q.data;

  return <Breakdown d={d} />;
}

function Breakdown({ d }: { d: RequestDetail }) {
  const rows = useMemo(() => {
    const all = [
      ...d.request.system.map((m) => ({ m, seg: m.contextSource })),
      ...d.request.messages.map((m) => ({ m, seg: m.contextSource })),
    ];
    return all.map(({ m, seg }, i) => ({
      idx: i,
      segment: seg,
      role: m.role,
      chars: messageChars(m),
      blocks: m.blocks.length,
      label: `${i}. ${m.role}${seg !== m.role ? ` (${seg})` : ''}`,
    }));
  }, [d]);

  const bySegment = useMemo(() => {
    const map = new Map<string, { chars: number; count: number }>();
    for (const r of rows) {
      const cur = map.get(r.segment) ?? { chars: 0, count: 0 };
      cur.chars += r.chars;
      cur.count++;
      map.set(r.segment, cur);
    }
    const total = Math.max(
      1,
      [...map.values()].reduce((a, v) => a + v.chars, 0),
    );
    return { entries: [...map.entries()].sort((a, b) => b[1].chars - a[1].chars), total };
  }, [rows]);

  const estTokens = (chars: number): number => Math.ceil(chars / 4);

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link
          to={`/requests/${d.summary.requestId}`}
          className="flex items-center gap-1 text-[12px] text-ink-dim hover:text-ink"
        >
          <ArrowLeft className="size-3.5" /> request
        </Link>
        <span className="font-mono text-[13px] font-semibold">
          context of {shortId(d.summary.requestId, 12)}
        </span>
        <Badge className="font-mono">{d.summary.model ?? d.summary.endpoint}</Badge>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-ink-dim">
          <span>
            redacted payload{' '}
            <b className="font-mono text-ink">{fmtBytes(d.request.rawRequestJson.length)}</b>
          </span>
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[380px_1fr]">
        <Card>
          <CardHeader
            title="Composition by segment"
            hint="chars of redacted content — real bytes"
          />
          <div className="space-y-2 px-3.5 pb-3">
            {/* stacked bar */}
            <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-raised">
              {bySegment.entries.map(([seg, v]) => (
                <Tip
                  key={seg}
                  content={`${seg}: ${fmtBytes(v.chars)} across ${v.count} message(s)`}
                >
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.max(1.5, (v.chars / bySegment.total) * 100)}%`,
                      background: SEGMENT_COLORS[seg] ?? 'var(--saga-ink-faint)',
                    }}
                  />
                </Tip>
              ))}
            </div>
            {bySegment.entries.map(([seg, v]) => (
              <div key={seg} className="flex items-center justify-between text-[12px]">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-sm"
                    style={{ background: SEGMENT_COLORS[seg] ?? 'var(--saga-ink-faint)' }}
                  />
                  {seg}
                  <span className="text-ink-faint">×{v.count}</span>
                </span>
                <span className="tabular-nums text-ink-dim">
                  {fmtBytes(v.chars)}
                  <Tip content="chars/4 heuristic — the wire reports no per-segment tokens. SAGA-estimated, labeled as such.">
                    <span className="ml-2 inline-flex cursor-default items-center gap-1 text-ink-faint">
                      <ProvenanceDot tone="saga" />~{fmtTokens(estTokens(v.chars))} tok
                    </span>
                  </Tip>
                </span>
              </div>
            ))}
            <div className="border-t border-line pt-2 text-[12px]">
              <div className="flex justify-between">
                <span className="text-ink-dim">whole-request input tokens</span>
                <TokenValue
                  usage={d.response.usage.input}
                  naReason="The wire reported no input token count for this request."
                />
              </div>
              <p className="pt-1.5 text-[11px] leading-4 text-ink-faint">
                The wire-reported total is the only trustworthy token figure here; the per-segment
                split above is a SAGA estimate by construction.
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Messages by size" hint="treemap of redacted content" />
          <div className={cn('h-[380px] px-2 pb-2')}>
            <Suspense fallback={<Skeleton className="h-full" />}>
              <Treemap
                items={rows.map((r) => ({
                  name: r.label,
                  value: Math.max(1, r.chars),
                  segment: r.segment,
                  color: SEGMENT_COLORS[r.segment] ?? 'var(--saga-ink-faint)',
                }))}
              />
            </Suspense>
          </div>
        </Card>
      </div>
    </div>
  );
}
