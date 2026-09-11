import {
  AggValue,
  Badge,
  Button,
  Card,
  EmptyState,
  fmtDateTime,
  fmtMs,
  InferredTag,
  listContainer,
  listItem,
  Skeleton,
  STAGGER_CAP,
  shortId,
  timeAgo,
  WireTag,
} from '@saga/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { Page } from '../shell/Page';

/** Warm the detail chunk while the pointer is still travelling to the row. */
const prefetchDetail = (): void => {
  void import('./SessionDetailPage');
};

const TH = 'px-3.5 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint';

export function SessionsPage() {
  const navigate = useNavigate();
  const q = useInfiniteQuery({
    queryKey: ['sessions'],
    queryFn: ({ pageParam }) => api.sessions({ limit: 50, cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Page>
      <div className="flex items-center gap-2 text-[12px] text-ink-dim">
        Sessions marked <WireTag what="session" /> are bounded by an id the client stated on the
        wire. The rest are grouped by a heuristic <InferredTag what="session" /> — client,
        workspace, and system-prompt fingerprint, split on 30 minutes of idle.
      </div>

      {q.isLoading ? (
        <Card>
          <div className="space-y-px p-2">
            {['a', 'b', 'c', 'd', 'e', 'f'].map((k) => (
              <Skeleton key={k} className="h-11" />
            ))}
          </div>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Layers />} title="No sessions yet">
          Sessions appear as soon as traffic flows through the proxy — route a client at :8787 or
          replay the fixture corpus.
        </EmptyState>
      ) : (
        <Card>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-left">
                <th className={TH}>session</th>
                <th className={TH}>client · workspace</th>
                <th className={`${TH} text-right`}>requests</th>
                <th className={`${TH} text-right`}>errors</th>
                <th className={`${TH} text-right`}>in</th>
                <th className={`${TH} text-right`}>out</th>
                <th className={`${TH} text-right`}>wall time</th>
                <th className={`${TH} text-right`}>last activity</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {items.map((s, i) => (
                <motion.tr
                  key={s.sessionId}
                  variants={i < STAGGER_CAP ? listItem : undefined}
                  onPointerEnter={prefetchDetail}
                  onClick={() => navigate(`/sessions/${s.sessionId}`)}
                  className="cursor-pointer border-b border-line/50 transition-colors duration-(--dur-1) last:border-0 hover:bg-raised/50"
                >
                  <td className="px-3.5 py-2">
                    <div className="flex items-center gap-1.5">
                      <motion.span layoutId={`s-title-${s.sessionId}`} className="min-w-0">
                        <Link
                          to={`/sessions/${s.sessionId}`}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={prefetchDetail}
                          className={
                            s.title
                              ? 'block truncate font-medium text-accent hover:underline'
                              : 'block truncate font-mono text-accent hover:underline'
                          }
                        >
                          {/* The client's own name for the conversation beats an
                              opaque id whenever enrichment has found one. */}
                          {s.title ?? shortId(s.sessionId)}
                        </Link>
                      </motion.span>
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
                  <td className="px-3.5 py-2 text-right font-mono tabular-nums">{s.requests}</td>
                  <td className="px-3.5 py-2 text-right font-mono tabular-nums">
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
                  <td className="px-3.5 py-2 text-right font-mono text-[11.5px] tabular-nums text-ink-dim">
                    {fmtMs(s.totalLatencyMs)}
                  </td>
                  <td
                    className="px-3.5 py-2 text-right text-[11.5px] text-ink-faint"
                    title={fmtDateTime(s.lastActivityAt)}
                  >
                    {timeAgo(s.lastActivityAt)}
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
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
    </Page>
  );
}
