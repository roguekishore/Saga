import type { RequestDetail } from '@saga/contracts';
import { Badge, Button, Card, cn, EmptyState, fmtTime, Select, Skeleton, shortId } from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { type DiffLine, diffLines, diffStats } from '../lib/diff';

/**
 * Prompt Diff: what changed between two requests' payloads — typically two
 * turns of one session, where the delta IS the injected context. LCS line
 * diff, no Monaco: added/removed/context is the whole requirement.
 */

type Mode = 'conversation' | 'raw';

function textOf(d: RequestDetail, mode: Mode): string {
  if (mode === 'raw') {
    try {
      return JSON.stringify(JSON.parse(d.request.rawRequestJson), null, 2);
    } catch {
      return d.request.rawRequestJson;
    }
  }
  const parts: string[] = [];
  for (const m of [...d.request.system, ...d.request.messages]) {
    parts.push(`━━ ${m.role} (${m.contextSource})`);
    for (const b of m.blocks) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'thinking') parts.push(`[thinking] ${b.thinking}`);
      else if (b.type === 'tool_use') parts.push(`[tool_use ${b.name}] ${b.inputJson ?? ''}`);
      else if (b.type === 'tool_result')
        parts.push(
          `[tool_result ${b.toolUseId}] ${b.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join(' ')}`,
        );
      else parts.push(`[${b.type}]`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

export function DiffPage() {
  const recent = useQuery({
    queryKey: ['requests-diff'],
    queryFn: () => api.requests({ limit: 100 }),
  });
  const items = recent.data?.items ?? [];
  const [aId, setAId] = useState<string>('');
  const [bId, setBId] = useState<string>('');
  const [mode, setMode] = useState<Mode>('conversation');
  const [sideBySide, setSideBySide] = useState(true);

  const a = items.find((i) => i.requestId === aId) ?? items[1];
  const b = items.find((i) => i.requestId === bId) ?? items[0];

  const aDetail = useQuery({
    queryKey: ['request', a?.requestId],
    queryFn: () => api.requestDetail(a!.requestId),
    enabled: !!a,
  });
  const bDetail = useQuery({
    queryKey: ['request', b?.requestId],
    queryFn: () => api.requestDetail(b!.requestId),
    enabled: !!b,
  });

  const diff = useMemo(() => {
    if (!aDetail.data || !bDetail.data) return null;
    return diffLines(textOf(aDetail.data, mode), textOf(bDetail.data, mode));
  }, [aDetail.data, bDetail.data, mode]);

  if (recent.isLoading) return <Skeleton className="m-4 h-72" />;
  if (items.length < 2) {
    return (
      <div className="p-6">
        <EmptyState icon={<ArrowLeftRight />} title="Need at least two captured requests" />
      </div>
    );
  }

  const stats = diff ? diffStats(diff.lines) : null;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={a?.requestId ?? ''}
          onChange={(e) => setAId(e.target.value)}
          className="max-w-64 font-mono"
        >
          {items.map((i) => (
            <option key={i.requestId} value={i.requestId}>
              A · {fmtTime(i.ts)} {i.model ?? i.endpoint} {shortId(i.requestId, 6)}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          onClick={() => {
            setAId(b?.requestId ?? '');
            setBId(a?.requestId ?? '');
          }}
          aria-label="swap"
        >
          <ArrowLeftRight className="size-3.5" />
        </Button>
        <Select
          value={b?.requestId ?? ''}
          onChange={(e) => setBId(e.target.value)}
          className="max-w-64 font-mono"
        >
          {items.map((i) => (
            <option key={i.requestId} value={i.requestId}>
              B · {fmtTime(i.ts)} {i.model ?? i.endpoint} {shortId(i.requestId, 6)}
            </option>
          ))}
        </Select>
        <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="conversation">conversation text</option>
          <option value="raw">raw JSON</option>
        </Select>
        <Button variant={sideBySide ? 'solid' : 'outline'} onClick={() => setSideBySide((v) => !v)}>
          {sideBySide ? 'side-by-side' : 'inline'}
        </Button>
        {stats ? (
          <span className="ml-auto flex items-center gap-2 text-[12px]">
            <Badge tone="ok">+{stats.added}</Badge>
            <Badge tone="err">−{stats.removed}</Badge>
            {diff?.truncated ? <Badge tone="warn">too large — block diff</Badge> : null}
          </span>
        ) : null}
      </div>

      {!diff ? (
        <Skeleton className="h-96" />
      ) : sideBySide ? (
        <SideBySide lines={diff.lines} />
      ) : (
        <Inline lines={diff.lines} />
      )}
    </div>
  );
}

const LINE_STYLE: Record<DiffLine['kind'], string> = {
  same: 'text-ink-dim',
  add: 'bg-ok/10 text-ok',
  del: 'bg-err/10 text-err',
};

function Inline({ lines }: { lines: DiffLine[] }) {
  return (
    <Card className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-5">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional; no stable id
        <div key={i} className={cn('flex whitespace-pre-wrap break-all px-2', LINE_STYLE[l.kind])}>
          <span className="w-5 shrink-0 select-none text-ink-faint">
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
          </span>
          <span>{l.text || ' '}</span>
        </div>
      ))}
    </Card>
  );
}

function SideBySide({ lines }: { lines: DiffLine[] }) {
  // pair del/add runs into rows
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === 'same') {
      rows.push({ left: l, right: l });
      i++;
    } else {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i]!.kind === 'del') dels.push(lines[i++]!);
      while (i < lines.length && lines[i]!.kind === 'add') adds.push(lines[i++]!);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return (
    <Card className="min-h-0 flex-1 overflow-auto">
      <div className="grid grid-cols-2 font-mono text-[11.5px] leading-5">
        {rows.map((r, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional; no stable id
          <div key={idx} className="contents">
            <div
              className={cn(
                'whitespace-pre-wrap break-all border-r border-line/60 px-2',
                r.left ? LINE_STYLE[r.left.kind] : 'bg-raised/40',
              )}
            >
              {r.left?.text ?? ''}
            </div>
            <div
              className={cn(
                'whitespace-pre-wrap break-all px-2',
                r.right ? LINE_STYLE[r.right.kind] : 'bg-raised/40',
              )}
            >
              {r.right?.text ?? ''}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
