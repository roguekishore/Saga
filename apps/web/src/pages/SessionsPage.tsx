import {
  AggValue,
  Badge,
  Button,
  Card,
  EmptyState,
  fmtDateTime,
  fmtMs,
  InferredTag,
  Skeleton,
  shortId,
  timeAgo,
  WireTag,
} from '@saga/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api';

export function SessionsPage() {
  const q = useInfiniteQuery({
    queryKey: ['sessions'],
    queryFn: ({ pageParam }) => api.sessions({ limit: 50, cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-[12px] text-ink-dim">
        Sessions marked <WireTag what="session" /> are bounded by an id the client stated on the
        wire. The rest are grouped by a heuristic <InferredTag what="session" /> — client,
        workspace, and system-prompt fingerprint, split on 30 minutes of idle.
      </div>

      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : items.length === 0 ? (
        <EmptyState icon={<Layers />} title="No sessions yet">
          Sessions appear as soon as traffic flows through the proxy.
        </EmptyState>
      ) : (
        <Card>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
                <th className="px-3.5 py-2 font-semibold">session</th>
                <th className="px-3.5 py-2 font-semibold">client · workspace</th>
                <th className="px-3.5 py-2 text-right font-semibold">requests</th>
                <th className="px-3.5 py-2 text-right font-semibold">errors</th>
                <th className="px-3.5 py-2 text-right font-semibold">in</th>
                <th className="px-3.5 py-2 text-right font-semibold">out</th>
                <th className="px-3.5 py-2 text-right font-semibold">wall time</th>
                <th className="px-3.5 py-2 text-right font-semibold">last activity</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr
                  key={s.sessionId}
                  className="border-b border-line/50 last:border-0 hover:bg-raised/50"
                >
                  <td className="px-3.5 py-2">
                    <div className="flex items-center gap-1.5">
                      <Link
                        to={`/sessions/${s.sessionId}`}
                        className={
                          s.title
                            ? 'truncate font-medium text-accent hover:underline'
                            : 'font-mono text-accent hover:underline'
                        }
                      >
                        {/* The client's own name for the conversation beats an
                            opaque id whenever enrichment has found one. */}
                        {s.title ?? shortId(s.sessionId)}
                      </Link>
                      {s.inferred ? <InferredTag what="session" /> : <WireTag what="session" />}
                    </div>
                    <div className="mt-0.5 flex gap-1">
                      {s.models.map((m) => (
                        <Badge key={m} className="font-mono text-[10px]">
                          {m}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="max-w-[260px] px-3.5 py-2">
                    <div className="truncate text-ink-dim">{s.clientName ?? 'unknown client'}</div>
                    {s.workspace ? (
                      <div className="flex items-center gap-1.5 truncate font-mono text-[11px] text-ink-faint">
                        {s.workspace} <InferredTag what="workspace" />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3.5 py-2 text-right tabular-nums">{s.requests}</td>
                  <td className="px-3.5 py-2 text-right tabular-nums">
                    {s.errors > 0 ? (
                      <span className="text-err">{s.errors}</span>
                    ) : (
                      <span className="text-ink-faint">0</span>
                    )}
                  </td>
                  <td className="px-3.5 py-2 text-right">
                    <AggValue agg={s.inputTokens} />
                  </td>
                  <td className="px-3.5 py-2 text-right">
                    <AggValue agg={s.outputTokens} />
                  </td>
                  <td className="px-3.5 py-2 text-right font-mono text-[11.5px] text-ink-dim">
                    {fmtMs(s.totalLatencyMs)}
                  </td>
                  <td
                    className="px-3.5 py-2 text-right text-[11.5px] text-ink-faint"
                    title={fmtDateTime(s.lastActivityAt)}
                  >
                    {timeAgo(s.lastActivityAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.hasNextPage ? (
            <div className="border-t border-line p-2 text-center">
              <Button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? 'loading…' : 'load more'}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
