import {
  type BlockContextKind,
  classifyBlocks,
  type ContentBlock,
  type NormalizedMessage,
  type RequestDetail,
} from '@saga/contracts';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  fmtBytes,
  fmtTokens,
  ProvenanceMark,
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
import { useThemeColors } from '../lib/use-theme-colors';
import { Page } from '../shell/Page';

const Treemap = lazy(() => import('../components/ContextTreemap'));

/**
 * Context Breakdown: why is this prompt large? Byte numbers are REAL
 * (redacted payload bytes). Token-level splits per segment do not exist on
 * the wire — the only honest per-segment token figure is a SAGA estimate,
 * and it is labeled as exactly that.
 */

/**
 * Segments are derived PER BLOCK, not per message.
 *
 * This page used to group by `message.contextSource`, whose vocabulary is
 * positional (system / history / user / tool / assistant) and structurally
 * cannot report `memory`: recalled instructions arrive as one text block INSIDE
 * a message whose position makes it `system` or `history`. So the memory slot
 * had a colour, a legend entry and a treemap key, and was mathematically
 * guaranteed to read zero — measured on the live corpus: 892 stored messages,
 * `context_source = 'memory'` on none of them, while per-block classification
 * finds 76 memory blocks (marker `MEMORY.md`) filed under system (32), history
 * (26) and user (18).
 *
 * `classifyBlock` already answers this correctly and is derived on read, so the
 * fix is to ask it instead of the message-level field. Bucketed to keep the
 * legend readable: ten block kinds collapse onto seven segments, and the two
 * that matter for "why is this prompt large" — memory and injected context —
 * each keep their own.
 */
const SEGMENT_VARS: Array<[segment: string, cssVar: string]> = [
  ['system prompt', '--saga-cat-1'],
  ['memory / instructions', '--saga-cat-2'],
  ['tool results', '--saga-cat-3'],
  ['your input', '--saga-cat-4'],
  ['injected context', '--saga-cat-5'],
  ['model output', '--saga-cat-6'],
  ['other', '--saga-ink-faint'],
];

/** Block kind → segment. Every kind is listed; nothing falls through silently. */
const KIND_SEGMENT: Record<BlockContextKind, string> = {
  'system-prompt': 'system prompt',
  memory: 'memory / instructions',
  'tool-result': 'tool results',
  'user-prose': 'your input',
  'system-reminder': 'injected context',
  'command-echo': 'injected context',
  'command-output': 'injected context',
  harness: 'injected context',
  'model-output': 'model output',
  'non-text': 'other',
};

const SEGMENT_COLORS: Record<string, string> = Object.fromEntries(
  SEGMENT_VARS.map(([seg, v]) => [seg, `var(${v})`]),
);

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

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-9" />
        <div className="grid gap-3 lg:grid-cols-[380px_1fr]">
          <Skeleton className="h-72" />
          <Skeleton className="h-[420px]" />
        </div>
      </div>
    );
  }
  if (!q.data) return <EmptyState className="m-6" title="Request not found" />;
  const d: RequestDetail = q.data;

  return <Breakdown d={d} />;
}

function Breakdown({ d }: { d: RequestDetail }) {
  /**
   * Every block of every message, classified. One pass feeds both views: the
   * composition bar aggregates blocks by segment, and the treemap keeps one
   * rectangle per message labelled by the segment that dominates its bytes.
   */
  const blocks = useMemo(() => {
    const out: Array<{ msgIdx: number; role: string; segment: string; chars: number }> = [];
    const messages = [...d.request.system, ...d.request.messages];
    messages.forEach((m, msgIdx) => {
      const ctxs = classifyBlocks(m.blocks, m.role);
      m.blocks.forEach((b, j) => {
        const kind = ctxs[j]?.kind;
        out.push({
          msgIdx,
          role: m.role,
          segment: kind ? (KIND_SEGMENT[kind] ?? 'other') : 'other',
          chars: blockChars(b),
        });
      });
    });
    return out;
  }, [d]);

  const rows = useMemo(() => {
    const messages = [...d.request.system, ...d.request.messages];
    return messages.map((m, i) => {
      // Dominant segment by bytes: a message mixing your prose with an injected
      // reminder is painted for whichever actually accounts for its size.
      const mine = blocks.filter((b) => b.msgIdx === i);
      const bySeg = new Map<string, number>();
      for (const b of mine) bySeg.set(b.segment, (bySeg.get(b.segment) ?? 0) + b.chars);
      const dominant = [...bySeg.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
      return {
        idx: i,
        segment: dominant,
        role: m.role,
        chars: messageChars(m),
        blocks: m.blocks.length,
        label: `${i}. ${m.role} (${dominant})`,
      };
    });
  }, [d, blocks]);

  const bySegment = useMemo(() => {
    const map = new Map<string, { chars: number; count: number }>();
    for (const b of blocks) {
      const cur = map.get(b.segment) ?? { chars: 0, count: 0 };
      cur.chars += b.chars;
      cur.count++;
      map.set(b.segment, cur);
    }
    // A zero-char segment (an image block, say) still counts as present, but a
    // segment with no blocks at all is simply absent rather than shown as 0 —
    // an empty row that could never fill is what this page was doing before.
    const total = Math.max(
      1,
      [...map.values()].reduce((a, v) => a + v.chars, 0),
    );
    return { entries: [...map.entries()].sort((a, b) => b[1].chars - a[1].chars), total };
  }, [blocks]);

  const estTokens = (chars: number): number => Math.ceil(chars / 4);

  // The treemap paints to canvas, which cannot resolve CSS variables — feed
  // it theme-resolved hex while the DOM swatches keep the live var() form.
  const resolved = useThemeColors(SEGMENT_VARS.map(([, v]) => v));
  const treemapColor = (seg: string): string => {
    const i = SEGMENT_VARS.findIndex(([name]) => name === seg);
    return resolved[i === -1 ? SEGMENT_VARS.length - 1 : i]!;
  };

  return (
    <Page>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link
          to={`/requests/${d.summary.requestId}`}
          className="flex items-center gap-1 text-[12px] text-ink-dim transition-colors duration-(--dur-1) hover:text-ink"
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
            <b className="font-mono tabular-nums text-ink">
              {fmtBytes(d.request.rawRequestJson.length)}
            </b>
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
            {/* stacked bar — 2px canvas gaps keep adjacent fills separable */}
            <div className="flex h-3.5 w-full gap-[2px] overflow-hidden rounded-full">
              {bySegment.entries.map(([seg, v]) => (
                <Tip
                  key={seg}
                  content={`${seg}: ${fmtBytes(v.chars)} across ${v.count} message(s)`}
                >
                  <div
                    className="h-full first:rounded-l-full last:rounded-r-full"
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
                <span className="font-mono tabular-nums text-ink-dim">
                  {fmtBytes(v.chars)}
                  <Tip content="chars/4 heuristic — the wire reports no per-segment tokens. SAGA-estimated, labeled as such.">
                    <span className="ml-2 inline-flex cursor-default items-center gap-1 text-ink-faint">
                      <ProvenanceMark tone="saga" />~{fmtTokens(estTokens(v.chars))} tok
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
          <div className="h-[420px] px-2 pb-2">
            <Suspense fallback={<Skeleton className="h-full" />}>
              <Treemap
                items={rows.map((r) => ({
                  name: r.label,
                  value: Math.max(1, r.chars),
                  segment: r.segment,
                  color: treemapColor(r.segment),
                }))}
              />
            </Suspense>
          </div>
        </Card>
      </div>
    </Page>
  );
}
