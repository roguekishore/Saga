import type { RequestDetail } from '@saga/contracts';
import {
  Badge,
  Card,
  CardHeader,
  cn,
  dur,
  EmptyState,
  ease,
  fmtBytes,
  fmtClockMs,
  fmtDateTime,
  fmtMs,
  InferredTag,
  listContainer,
  listItem,
  NaValue,
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
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useParams } from 'react-router';
import { MessageCard } from '../components/BlockView';
import { JsonView } from '../components/JsonTree';
import { api } from '../lib/api';
import { Page } from '../shell/Page';

const CACHE_NA =
  'Nothing on this upstream produces cache token fields — verified against kiro-gateway. n/a, not 0.';

const TH = 'px-3.5 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint';

export function RequestInspectorPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['request', id],
    queryFn: () => api.requestDetail(id),
    refetchInterval: (query) => (query.state.data?.summary.status === null ? 1500 : false),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-9" />
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="p-6">
        <EmptyState title="Request not found">
          It may predate the current database, or the id is wrong.{' '}
          <Link to="/live" className="text-accent hover:underline">
            Back to Live Monitor
          </Link>
        </EmptyState>
      </div>
    );
  }
  const d: RequestDetail = q.data;
  const s = d.summary;

  return (
    <Page>
      {/* ------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to="/live"
          className="flex items-center gap-1 text-[12px] text-ink-dim transition-colors duration-(--dur-1) hover:text-ink"
        >
          <ArrowLeft className="size-3.5" /> live
        </Link>
        <motion.span layoutId={`r-hero-${s.requestId}`} className="inline-flex items-center gap-3">
          <span className="font-mono text-[13px] font-semibold">{shortId(s.requestId, 12)}</span>
          <StatusPill status={s.status} />
        </motion.span>
        <span className="font-mono text-[12px] text-ink-dim">{s.model ?? s.endpoint}</span>
        <Badge>{s.adapterId}</Badge>
        {s.stream ? <Badge tone="info">stream</Badge> : <Badge>non-stream</Badge>}
        <Tip content={`Session ${s.sessionId}`}>
          <Link
            to={`/sessions/${s.sessionId}`}
            className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors duration-(--dur-1) hover:text-ink"
          >
            {shortId(s.sessionId)} <InferredTag what="session" />
          </Link>
        </Tip>
        <Link
          to={`/requests/${s.requestId}/context`}
          className="text-[11.5px] font-medium text-accent hover:underline"
        >
          context breakdown →
        </Link>
        <span className="ml-auto font-mono text-[11.5px] tabular-nums text-ink-faint">
          {fmtDateTime(s.ts)}
        </span>
      </div>

      {/* ------------------------------------------------ usage + timing */}
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Timing" hint="measured at the proxy, client-side of the wire" />
          <div className="px-3.5 pb-3.5">
            <TimelineBar
              key={s.requestId}
              sentAt={d.timeline.sentAt}
              firstTokenAt={d.timeline.firstTokenAt}
              finishedAt={d.timeline.finishedAt}
            />
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-dim">
              <span>
                ttft <b className="font-mono tabular-nums text-ink">{fmtMs(s.ttftMs)}</b>
              </span>
              <span>
                total <b className="font-mono tabular-nums text-ink">{fmtMs(s.latencyMs)}</b>
              </span>
              {d.frameStats ? (
                <span className="font-mono tabular-nums">
                  {d.frameStats.frames} frames · {fmtBytes(d.frameStats.bytes)}
                  {d.frameStats.parseErrors > 0 ? (
                    <span className="text-warn"> · {d.frameStats.parseErrors} parse errors</span>
                  ) : null}
                </span>
              ) : null}
              {s.errorMessage ? <span className="text-err">{s.errorMessage}</span> : null}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Usage" hint="value + source, always" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 pb-3.5 text-[12.5px]">
            <UsageSlot label="input" v={<TokenValue usage={d.response.usage.input} />} />
            <UsageSlot label="output" v={<TokenValue usage={d.response.usage.output} />} />
            <UsageSlot
              label="cache read"
              v={
                d.response.usage.cacheRead ? (
                  <TokenValue usage={d.response.usage.cacheRead} />
                ) : (
                  <NaValue reason={CACHE_NA} />
                )
              }
            />
            <UsageSlot
              label="cache write"
              v={
                d.response.usage.cacheWrite ? (
                  <TokenValue usage={d.response.usage.cacheWrite} />
                ) : (
                  <NaValue reason={CACHE_NA} />
                )
              }
            />
            <UsageSlot label="stop reason" v={d.response.stopReason ?? '–'} />
            <UsageSlot
              label="redaction"
              v={
                d.redaction.flagged ? (
                  <Tip content="Fail-closed: an unrecognized high-entropy blob was scrubbed. Review what the client is sending.">
                    <span className="inline-flex items-center gap-1 text-warn">
                      <ShieldAlert className="size-3.5" /> flagged
                    </span>
                  </Tip>
                ) : d.redaction.hits.length > 0 ? (
                  <Tip
                    content={`Scrubbed before anything touched disk: ${d.redaction.hits
                      .map((h) => `${h.kind}×${h.count}`)
                      .join(', ')}`}
                  >
                    <span className="inline-flex items-center gap-1 text-ok">
                      <ShieldCheck className="size-3.5" />
                      {d.redaction.hits.reduce((a, h) => a + h.count, 0)} scrubbed
                    </span>
                  </Tip>
                ) : (
                  <span className="text-ink-faint">clean</span>
                )
              }
            />
          </div>
        </Card>
      </div>

      {/* --------------------------------------------------------- tabs */}
      <Tabs defaultValue="conversation">
        <TabsList>
          <TabsTrigger value="conversation">
            Conversation
            <span className="ml-1.5 font-mono text-[10.5px] tabular-nums text-ink-faint">
              {d.request.system.length + d.request.messages.length + (d.response.message ? 1 : 0)}
            </span>
          </TabsTrigger>
          <TabsTrigger value="tools">
            Tool definitions
            <span className="ml-1.5 font-mono text-[10.5px] tabular-nums text-ink-faint">
              {d.request.tools.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="params">Params</TabsTrigger>
          <TabsTrigger value="raw">Raw JSON</TabsTrigger>
        </TabsList>

        <TabsContent value="conversation" className="pt-3">
          <motion.div
            variants={listContainer}
            initial="initial"
            animate="animate"
            className="space-y-2.5"
          >
            {d.request.system.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: system messages are positional
              <motion.div key={`s${i}`} variants={i < STAGGER_CAP ? listItem : undefined}>
                <MessageCard msg={m} title="system" requestTs={s.ts} />
              </motion.div>
            ))}
            {d.request.messages.map((m, i) => (
              <motion.div
                // biome-ignore lint/suspicious/noArrayIndexKey: conversation messages are positional
                key={`m${i}`}
                variants={d.request.system.length + i < STAGGER_CAP ? listItem : undefined}
              >
                <MessageCard msg={m} requestTs={s.ts} />
              </motion.div>
            ))}
            {d.response.message ? (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: dur.base, ease: ease.out }}
                className="relative"
              >
                <div className="absolute -left-2 top-0 bottom-0 w-0.5 rounded bg-accent/60" />
                <MessageCard
                  msg={d.response.message}
                  title="assistant · response"
                  requestTs={s.ts}
                />
              </motion.div>
            ) : (
              <EmptyState title={s.status === null ? 'Still streaming…' : 'No response captured'}>
                {s.status === 'upstream_error'
                  ? 'The upstream returned an error before producing content.'
                  : s.status === null
                    ? 'This view refreshes live until the request finishes.'
                    : 'The stream ended without content frames.'}
              </EmptyState>
            )}
          </motion.div>
        </TabsContent>

        <TabsContent value="tools" className="pt-3">
          {d.request.tools.length === 0 ? (
            <EmptyState title="No tools in this request" />
          ) : (
            <Card>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className={TH}>name</th>
                    <th className={TH}>description</th>
                    <th className={`${TH} text-right`}>schema</th>
                  </tr>
                </thead>
                <tbody>
                  {d.request.tools.map((t) => (
                    <tr key={t.name} className="border-b border-line/50 last:border-0">
                      <td className="px-3.5 py-1.5 font-mono">{t.name}</td>
                      <td className="px-3.5 py-1.5 font-mono tabular-nums text-ink-dim">
                        {fmtBytes(t.descriptionBytes)}
                      </td>
                      <td className="px-3.5 py-1.5 text-right font-mono tabular-nums text-ink-dim">
                        {fmtBytes(t.inputSchemaBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-3.5 py-2 text-[11px] text-ink-faint">
                Full definitions live in the Raw JSON tab — sizes here, bytes there.
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="params" className="pt-3">
          <JsonView json={d.request.paramsJson} />
        </TabsContent>

        <TabsContent value="raw" className="pt-3">
          <div className="mb-2 text-[11.5px] text-ink-faint">
            The exact payload the client sent, after redaction. Redacted spans render{' '}
            <span className="text-warn">amber</span>.
          </div>
          <JsonView json={d.request.rawRequestJson} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function UsageSlot({ label, v }: { label: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}

/** One timeline tick: what happened, and the wall clock it happened at. */
function Tick({
  label,
  at,
  align = 'left',
}: {
  label: string;
  at: number | null;
  align?: 'left' | 'center' | 'right';
}) {
  return (
    <span
      className={cn(
        'flex flex-col gap-px',
        align === 'center' ? 'items-center' : align === 'right' ? 'items-end' : 'items-start',
      )}
    >
      <span>{label}</span>
      {at != null ? (
        <span className="font-mono tabular-nums text-ink-dim">{fmtClockMs(at)}</span>
      ) : null}
    </span>
  );
}

function TimelineBar({
  sentAt,
  firstTokenAt,
  finishedAt,
}: {
  sentAt: number;
  firstTokenAt: number | null;
  finishedAt: number | null;
}) {
  const end = finishedAt ?? firstTokenAt ?? sentAt + 1;
  const total = Math.max(1, end - sentAt);
  const waitPct = firstTokenAt ? ((firstTokenAt - sentAt) / total) * 100 : 100;

  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-raised">
        <Tip
          content={`waiting for first token — ${fmtMs(firstTokenAt ? firstTokenAt - sentAt : null)}`}
        >
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: dur.slow, ease: ease.out }}
            className="h-full origin-left bg-info/60"
            style={{ width: `${Math.max(2, Math.min(100, waitPct))}%` }}
          />
        </Tip>
        {firstTokenAt && finishedAt ? (
          <Tip content={`streaming — ${fmtMs(finishedAt - firstTokenAt)}`}>
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: dur.slow, ease: ease.out, delay: dur.slow * 0.7 }}
              className="h-full flex-1 origin-left bg-accent/70"
            />
          </Tip>
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-ink-faint">
        <Tick label="sent" at={sentAt} />
        <Tick
          label={firstTokenAt ? 'first token' : 'no content frames'}
          at={firstTokenAt}
          align="center"
        />
        <Tick label={finishedAt ? 'finished' : 'in flight'} at={finishedAt} align="right" />
      </div>
      <div className="mt-1.5 text-[10.5px] text-ink-faint">
        Honest spans only: upstream internals (queueing, memory injection, provider time) are
        invisible from a wrapper — SAGA shows what it can actually measure.
      </div>
    </div>
  );
}
