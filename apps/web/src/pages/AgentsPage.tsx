import type { AgentSummary } from '@saga/contracts';
import {
  AggValue,
  Card,
  CardHeader,
  EmptyState,
  fmtInt,
  InferredTag,
  Select,
  Skeleton,
  shortId,
  timeAgo,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { Bot, CornerDownRight } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';

const AgentGraph = lazy(() => import('../components/AgentGraph'));

/**
 * Agent Explorer + Graph. Correlation is a heuristic from prompt shape and
 * timing overlap — the page says so up front and every element carries the
 * inferred tag. Never presented as ground truth.
 */
export function AgentsPage() {
  const agentsQ = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    refetchInterval: 10_000,
  });

  const bySession = useMemo(() => {
    const map = new Map<string, AgentSummary[]>();
    for (const a of agentsQ.data ?? []) {
      map.set(a.sessionId, [...(map.get(a.sessionId) ?? []), a]);
    }
    return [...map.entries()].sort(
      (x, y) =>
        Math.max(...y[1].map((a) => a.lastSeenAt)) - Math.max(...x[1].map((a) => a.lastSeenAt)),
    );
  }, [agentsQ.data]);

  const [selected, setSelected] = useState<string | null>(null);
  const sessionId = selected ?? bySession[0]?.[0] ?? null;
  const agents = bySession.find(([sid]) => sid === sessionId)?.[1] ?? [];

  if (agentsQ.isLoading) return <Skeleton className="m-4 h-72" />;

  if (bySession.length === 0) {
    return (
      <div className="p-6">
        <EmptyState icon={<Bot />} title="No agents correlated yet">
          Agents appear when a session shows more than one system-prompt fingerprint — e.g. a Claude
          Code run that spawns subagents. Correlation is heuristic and always labeled inferred.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-ink-dim">
          Parent/child edges are inferred from timing overlap <InferredTag what="agent" />
        </span>
        <Select
          className="ml-auto max-w-72 font-mono text-[12px]"
          value={sessionId ?? ''}
          onChange={(e) => setSelected(e.target.value)}
        >
          {bySession.map(([sid, list]) => (
            <option key={sid} value={sid}>
              {shortId(sid)} — {list.length} agent{list.length === 1 ? '' : 's'}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-3 lg:grid-cols-[360px_1fr]">
        {/* --------------------------------------------------- agent list */}
        <Card>
          <CardHeader
            title="Agents"
            hint="hierarchy"
            right={
              sessionId ? (
                <Link
                  to={`/sessions/${sessionId}`}
                  className="text-[11.5px] text-accent hover:underline"
                >
                  open session →
                </Link>
              ) : undefined
            }
          />
          <div className="px-2 pb-2">
            <AgentTree agents={agents} />
          </div>
        </Card>

        {/* -------------------------------------------------------- graph */}
        <Card className="min-h-[420px]">
          <CardHeader title="Agent graph" hint="React Flow + ELK · zoom, pan, drag" />
          <div className="h-[420px]">
            <Suspense fallback={<Skeleton className="m-3 h-[380px]" />}>
              <AgentGraph agents={agents} />
            </Suspense>
          </div>
        </Card>
      </div>
    </div>
  );
}

function AgentTree({ agents }: { agents: AgentSummary[] }) {
  const roots = agents.filter(
    (a) => !a.parentAgentId || !agents.some((p) => p.agentId === a.parentAgentId),
  );
  const children = (id: string): AgentSummary[] => agents.filter((a) => a.parentAgentId === id);

  const renderNode = (a: AgentSummary, depth: number): React.ReactNode => (
    <div key={a.agentId}>
      <Link
        to={`/live?agent=${a.agentId}`}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised/70"
        style={{ paddingLeft: 8 + depth * 18 }}
      >
        {depth > 0 ? (
          <CornerDownRight className="size-3.5 shrink-0 text-inferred" />
        ) : (
          <Bot className="size-3.5 shrink-0 text-accent" />
        )}
        <span className="truncate text-[12.5px] font-medium">{a.label}</span>
        <InferredTag what="agent" />
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[11px] text-ink-dim">
          <span>{fmtInt(a.requests)} req</span>
          <AggValue agg={a.outputTokens} />
          <span className="text-ink-faint">{timeAgo(a.lastSeenAt)}</span>
        </span>
      </Link>
      {children(a.agentId).map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return <div>{roots.map((a) => renderNode(a, 0))}</div>;
}
