import { API_PATHS, SessionSummarySchema } from '@saga/contracts';
import {
  AggValue,
  Badge,
  Button,
  Card,
  CardHeader,
  dur,
  EmptyState,
  ease,
  fmtBytes,
  fmtDateTime,
  fmtMs,
  fmtTokens,
  InferredTag,
  listContainer,
  listItem,
  Skeleton,
  STAGGER_CAP,
  StatusPill,
  shortId,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tip,
  TokenValue,
  WireTag,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Boxes,
  ChartArea,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { MessageCard } from '../components/BlockView';
import { AXIS, themedTooltip } from '../components/charts';
import { api } from '../lib/api';
import { webglAvailable } from '../lib/webgl';
import { Page } from '../shell/Page';

const ContextTopography = lazy(() => import('../components/ContextTopography'));

const prefetchInspector = (): void => {
  void import('./RequestInspectorPage');
};

const TH = 'px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint';

export function SessionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const summary = useQuery({
    queryKey: ['session-summary', id],
    queryFn: async () => {
      const res = await fetch(API_PATHS.sessionById(id));
      if (!res.ok) throw new Error('not found');
      return SessionSummarySchema.parse(await res.json());
    },
  });
  const requests = useQuery({
    queryKey: ['session-requests', id],
    queryFn: () => api.requests({ sessionId: id, limit: 500 }),
  });
  const growth = useQuery({
    queryKey: ['growth', id],
    queryFn: () => api.contextGrowth(id),
  });

  const s = summary.data;
  const reqs = useMemo(
    () => [...(requests.data?.items ?? [])].sort((a, b) => a.ts - b.ts),
    [requests.data],
  );

  if (summary.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (!s) {
    return (
      <div className="p-6">
        <EmptyState title="Session not found">
          It may predate the current database.{' '}
          <Link to="/sessions" className="text-accent hover:underline">
            Back to sessions
          </Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <Page>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link
          to="/sessions"
          className="flex items-center gap-1 text-[12px] text-ink-dim transition-colors duration-(--dur-1) hover:text-ink"
        >
          <ArrowLeft className="size-3.5" /> sessions
        </Link>
        <motion.span layoutId={`s-title-${s.sessionId}`} className="min-w-0">
          {s.title ? (
            <span className="text-[13px] font-semibold">{s.title}</span>
          ) : (
            <span className="font-mono text-[13px] font-semibold">{shortId(s.sessionId, 12)}</span>
          )}
        </motion.span>
        {s.inferred ? <InferredTag what="session" /> : <WireTag what="session" />}
        {s.models.map((m) => (
          <Badge key={m} className="font-mono">
            {m}
          </Badge>
        ))}
        <span className="text-[11.5px] text-ink-faint">
          {s.clientName ?? 'unknown client'}
          {/* cwd is read from the client's own transcript, so it outranks the
              workspace path sniffed out of prompt text. */}
          {s.cwd ? ` · ${s.cwd}` : s.workspace ? ` · ${s.workspace}` : ''}
          {s.gitBranch ? ` · ${s.gitBranch}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-ink-dim">
          <span className="font-mono tabular-nums">{s.requests} requests</span>
          <AggValue agg={s.outputTokens} render={(n) => `${fmtTokens(n)} out`} />
          <span className="font-mono tabular-nums">{fmtDateTime(s.startedAt)}</span>
        </span>
      </div>

      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="replay">Replay</TabsTrigger>
          <TabsTrigger value="growth">Context growth</TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------- requests tab */}
        <TabsContent value="requests" className="pt-3">
          <Card>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className={TH}>#</th>
                  <th className={TH}>time</th>
                  <th className={TH}>status</th>
                  <th className={TH}>model</th>
                  <th className={`${TH} text-right`}>in</th>
                  <th className={`${TH} text-right`}>out</th>
                  <th className={`${TH} text-right`}>latency</th>
                  <th className={`${TH} text-right`}>msgs</th>
                </tr>
              </thead>
              <motion.tbody variants={listContainer} initial="initial" animate="animate">
                {reqs.map((r, i) => (
                  <motion.tr
                    key={r.requestId}
                    variants={i < STAGGER_CAP ? listItem : undefined}
                    onPointerEnter={prefetchInspector}
                    onClick={() => navigate(`/requests/${r.requestId}`)}
                    className="cursor-pointer border-b border-line/50 transition-colors duration-(--dur-1) last:border-0 hover:bg-raised/50"
                  >
                    <td className="px-3 py-1.5 font-mono tabular-nums text-ink-faint">{i + 1}</td>
                    <td className="px-3 py-1.5 font-mono text-[11.5px] tabular-nums text-ink-dim">
                      {fmtDateTime(r.ts)}
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-1.5">
                      <motion.span layoutId={`r-hero-${r.requestId}`} className="inline-block">
                        <Link
                          to={`/requests/${r.requestId}`}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={prefetchInspector}
                          className="font-mono text-accent hover:underline"
                        >
                          {r.model ?? r.endpoint}
                        </Link>
                      </motion.span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <TokenValue usage={r.inputTokens} />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <TokenValue usage={r.outputTokens} />
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[11.5px] tabular-nums">
                      {fmtMs(r.latencyMs)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink-dim">
                      {r.messageCount}
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </Card>
        </TabsContent>

        {/* --------------------------------------------------- replay tab */}
        <TabsContent value="replay" className="pt-3">
          {reqs.length === 0 ? (
            <EmptyState title="Nothing to replay" />
          ) : (
            <Replay requestIds={reqs.map((r) => r.requestId)} />
          )}
        </TabsContent>

        {/* --------------------------------------------------- growth tab */}
        <TabsContent value="growth" className="pt-3">
          {growth.isLoading ? (
            <div className="grid gap-3 xl:grid-cols-2">
              <Skeleton className="h-64" />
              <Skeleton className="h-64" />
            </div>
          ) : (
            <GrowthTab points={growth.data?.points ?? []} />
          )}
        </TabsContent>
      </Tabs>
    </Page>
  );
}

/* ------------------------------------------------------------- replay */

function Replay({ requestIds }: { requestIds: string[] }) {
  const [turn, setTurn] = useState(0);
  const [playing, setPlaying] = useState(false);
  const id = requestIds[Math.min(turn, requestIds.length - 1)]!;
  const detail = useQuery({ queryKey: ['request', id], queryFn: () => api.requestDetail(id) });

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setTurn((cur) => {
        if (cur >= requestIds.length - 1) {
          setPlaying(false);
          return cur;
        }
        return cur + 1;
      });
    }, 1800);
    return () => clearInterval(t);
  }, [playing, requestIds.length]);

  const d = detail.data;
  const outThisTurn = d?.response.usage.output?.value ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button onClick={() => setTurn(0)} aria-label="first">
          <SkipBack className="size-3.5" />
        </Button>
        <Button onClick={() => setTurn((t) => Math.max(0, t - 1))} aria-label="prev">
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button variant="solid" onClick={() => setPlaying((p) => !p)} aria-label="play">
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? 'pause' : 'play'}
        </Button>
        <Button
          onClick={() => setTurn((t) => Math.min(requestIds.length - 1, t + 1))}
          aria-label="next"
        >
          <ChevronRight className="size-3.5" />
        </Button>
        <Button onClick={() => setTurn(requestIds.length - 1)} aria-label="last">
          <SkipForward className="size-3.5" />
        </Button>
        <span className="ml-2 font-mono text-[12px] tabular-nums text-ink-dim">
          turn {turn + 1} / {requestIds.length}
        </span>
        <div className="ml-auto flex items-center gap-3 font-mono text-[12px] tabular-nums text-ink-dim">
          {d ? (
            <>
              <span>{fmtDateTime(d.summary.ts)}</span>
              {outThisTurn != null ? <span>{fmtTokens(outThisTurn)} out this turn</span> : null}
            </>
          ) : null}
        </div>
      </div>

      {/* turn scrubber */}
      <div className="flex h-2 gap-px overflow-hidden rounded-full bg-raised">
        {requestIds.map((rid, i) => (
          <Tip key={rid} content={`turn ${i + 1}`}>
            <button
              type="button"
              onClick={() => setTurn(i)}
              aria-label={`turn ${i + 1}`}
              className={`h-full flex-1 cursor-pointer transition-colors duration-(--dur-1) ${
                i <= turn ? 'bg-accent/80' : 'bg-transparent'
              } hover:bg-accent`}
            />
          </Tip>
        ))}
      </div>

      {detail.isLoading || !d ? (
        <Skeleton className="h-72" />
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={d.summary.requestId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: dur.base, ease: ease.out }}
            className="space-y-2.5"
          >
            {d.request.messages.slice(-1).map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: single-item slice, positional
              <MessageCard key={i} msg={m} title="user · this turn" requestTs={d.summary.ts} />
            ))}
            {d.response.message ? (
              <div className="relative">
                <div className="absolute -left-2 top-0 bottom-0 w-0.5 rounded bg-accent/60" />
                <MessageCard msg={d.response.message} title="assistant" requestTs={d.summary.ts} />
              </div>
            ) : (
              <EmptyState title="No response captured for this turn" />
            )}
            <div className="text-right">
              <Link
                to={`/requests/${d.summary.requestId}`}
                className="text-[12px] text-accent hover:underline"
              >
                open full request →
              </Link>
            </div>
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

/* ------------------------------------------------------- context growth */

type GrowthPoint = import('@saga/contracts').ContextGrowth['points'][number];

function GrowthTab({ points }: { points: GrowthPoint[] }) {
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  const canTopo = webglAvailable() && points.length >= 3;

  if (points.length === 0) return <EmptyState title="No datapoints" />;

  return (
    <div className="space-y-3">
      {canTopo ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant={mode === '2d' ? 'solid' : 'outline'}
            onClick={() => setMode('2d')}
            aria-pressed={mode === '2d'}
          >
            <ChartArea className="size-3.5" /> charts
          </Button>
          <Tip content="The same four measures as the charts, extruded over turns. Purely an alternate view — every number here also exists in 2D.">
            <Button
              variant={mode === '3d' ? 'solid' : 'outline'}
              onClick={() => setMode('3d')}
              aria-pressed={mode === '3d'}
            >
              <Boxes className="size-3.5" /> topography
            </Button>
          </Tip>
        </div>
      ) : null}

      {mode === '3d' && canTopo ? (
        <Suspense fallback={<Skeleton className="h-[420px]" />}>
          <ContextTopography points={points} />
        </Suspense>
      ) : (
        <GrowthCharts points={points} />
      )}
    </div>
  );
}

function GrowthCharts({ points }: { points: GrowthPoint[] }) {
  const data = points.map((p) => ({
    turn: p.turn,
    input: p.inputTokens?.value ?? null,
    output: p.outputTokens?.value ?? null,
    bytes: p.requestBytes,
    messages: p.messageCount,
  }));
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader title="Input tokens per turn" hint="how the context balloons" />
        <div className="h-60 px-2 pb-2">
          <ResponsiveContainer>
            <AreaChart data={data}>
              <CartesianGrid stroke="var(--saga-line)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="turn" {...AXIS} />
              <YAxis {...AXIS} tickFormatter={(v: number) => fmtTokens(v)} width={48} />
              {themedTooltip()}
              <Area
                dataKey="input"
                stroke="var(--saga-info)"
                strokeWidth={1.5}
                fill="var(--saga-info)"
                fillOpacity={0.2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Request payload bytes per turn"
          hint="redacted wire bytes — a size signal with zero estimation"
        />
        <div className="h-60 px-2 pb-2">
          <ResponsiveContainer>
            <BarChart data={data}>
              <CartesianGrid stroke="var(--saga-line)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="turn" {...AXIS} />
              <YAxis {...AXIS} tickFormatter={(v: number) => fmtBytes(v)} width={56} />
              {themedTooltip()}
              <Bar
                dataKey="bytes"
                fill="var(--saga-accent)"
                fillOpacity={0.7}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
