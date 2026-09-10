import { Badge, Card, CardHeader, fmtInt, ProvenanceLegend, Skeleton } from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Settings — read-only view of the running configuration (set via SAGA_*
 * environment variables), the security posture stated plainly, and the
 * honest list of what a wrapper architecturally cannot see.
 */

const DEGRADED: Array<{ feature: string; reality: string; approach: string }> = [
  {
    feature: 'Memory Inspector',
    reality:
      'Memory provenance is decided in the client before the request; it never crosses the wire.',
    approach: 'Heuristic attribution by position and markers, always marked inferred.',
  },
  {
    feature: 'File Contribution',
    reality: 'No structured file manifest exists in the payload.',
    approach: 'Inline file content detected by pattern; partial by construction.',
  },
  {
    feature: 'Request Waterfall',
    reality: 'Upstream internal phases (queueing, memory injection, provider time) are invisible.',
    approach:
      'Honest spans only: sent → first content frame → stream end, plus in-stream tool marks.',
  },
  {
    feature: 'Logs Explorer',
    reality: 'Upstream gateway logs are outside the wrapper boundary.',
    approach: "SAGA's own logs; upstream only via an optional configured file tail (not enabled).",
  },
  {
    feature: 'Cache ratio & Cost',
    reality: 'The kiro upstream produces no cache fields and bills by subscription, not per token.',
    approach: 'Per-adapter; adapters without a source render n/a. Numbers are never invented.',
  },
];

export function SettingsPage() {
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  if (q.isLoading || !q.data) return <Skeleton className="m-4 h-72" />;
  const s = q.data;

  const rows: Array<[string, React.ReactNode, string?]> = [
    ['proxy', `http://${s.proxy.host}:${s.proxy.port}`, 'SAGA_PROXY_PORT'],
    ['upstream', s.proxy.upstream, 'SAGA_UPSTREAM'],
    ['read API', `http://${s.api.host}:${s.api.port}`, 'SAGA_API_PORT'],
    ['database', s.db.path, 'SAGA_DB'],
    ['capture queue', `${fmtInt(s.capture.queueCapacity)} events, drop-oldest`, 'SAGA_QUEUE_CAP'],
    ['raw SSE storage', s.capture.rawSse ? 'on' : 'off (default — assembled messages only)'],
    [
      'retention',
      `hot ${s.retention.hotDays}d · warm ${s.retention.warmDays}d · cold ${s.retention.coldDays}d · weekly cleanup + vacuum`,
    ],
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <Card className="border-warn/40">
        <div className="flex gap-2.5 px-3.5 py-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <p className="text-[12.5px] leading-5 text-ink-dim">{s.securityNote}</p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Runtime configuration"
          hint="set via environment variables, read-only here"
        />
        <div className="px-3.5 pb-3">
          {rows.map(([k, v, env]) => (
            <div
              key={k}
              className="flex items-baseline justify-between gap-3 border-b border-line/40 py-1.5 last:border-0"
            >
              <span className="text-[12px] text-ink-dim">{k}</span>
              <span className="flex items-center gap-2 text-right font-mono text-[12px]">
                {v}
                {env ? <Badge className="font-mono text-[9.5px]">{env}</Badge> : null}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="What a wrapper cannot see"
          hint="degraded by architecture — shown here so the UI never has to pretend"
        />
        <div className="space-y-3 px-3.5 pb-3.5">
          {DEGRADED.map((d) => (
            <div key={d.feature}>
              <div className="text-[12.5px] font-semibold">{d.feature}</div>
              <div className="text-[12px] text-ink-dim">{d.reality}</div>
              <div className="text-[12px] text-ink-faint">→ {d.approach}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Provenance legend" hint="every number in SAGA wears one of these" />
        <div className="px-3.5 pb-3.5">
          <ProvenanceLegend />
        </div>
      </Card>
    </div>
  );
}
