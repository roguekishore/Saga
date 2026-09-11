import {
  Badge,
  Card,
  CardHeader,
  cn,
  EmptyState,
  fmtInt,
  fmtMs,
  fmtTime,
  InferredTag,
  listContainer,
  listItem,
  NaValue,
  Skeleton,
  shortId,
  Tip,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { Page } from '../shell/Page';

/**
 * Tool Explorer: what tools the model called, whether results were observed
 * coming back, and the inferred round-trip. Result observation depends on the
 * client sending the tool_result in a later request — absence is honest.
 */
export function ToolsPage() {
  const stats = useQuery({
    queryKey: ['tool-stats'],
    queryFn: api.toolStats,
    refetchInterval: 10_000,
  });
  const [name, setName] = useState<string | null>(null);
  const calls = useQuery({
    queryKey: ['tool-calls', name],
    queryFn: () => api.toolCalls({ name: name ?? undefined, limit: 100 }),
  });

  if (stats.isLoading) {
    return (
      <div className="grid gap-3 p-4 lg:grid-cols-[340px_1fr]">
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders, no data identity
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }
  if ((stats.data?.length ?? 0) === 0) {
    return (
      <Page>
        <EmptyState icon={<Wrench />} title="No tool calls observed yet">
          Tool calls appear when responses carry tool_use blocks. Frame shapes are captured as
          observed on the wire — nothing is hardcoded from documentation.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page>
      <motion.div
        variants={listContainer}
        initial="initial"
        animate="animate"
        className="grid gap-3 lg:grid-cols-[340px_1fr]"
      >
        {/* --------------------------------------------------- tool list */}
        <motion.div variants={listItem} className="self-start">
          <Card>
            <CardHeader title="Tools" hint="by call volume" />
            <div className="px-2 pb-2">
              <button
                type="button"
                onClick={() => setName(null)}
                className={cn(
                  'relative flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px]',
                  'transition-colors duration-(--dur-1)',
                  name === null
                    ? 'bg-raised font-medium text-ink'
                    : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
                )}
              >
                {name === null ? (
                  <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent" />
                ) : null}
                all tools
              </button>
              {stats.data!.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setName(t.name)}
                  className={cn(
                    'group relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
                    'transition-colors duration-(--dur-1)',
                    name === t.name
                      ? 'bg-raised text-ink'
                      : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
                  )}
                >
                  {name === t.name ? (
                    <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent" />
                  ) : null}
                  <Wrench
                    className={cn(
                      'size-3.5 shrink-0 transition-colors duration-(--dur-1)',
                      name === t.name ? 'text-accent' : 'text-ink-faint group-hover:text-ink-dim',
                    )}
                  />
                  <span className="truncate font-mono text-[12.5px]">{t.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
                    <span className="font-mono tabular-nums text-ink-dim">{fmtInt(t.calls)}×</span>
                    {t.errors == null ? (
                      <NaValue reason="No tool_result for this tool was ever observed coming back — the client may not round-trip results through this proxy." />
                    ) : t.errors > 0 ? (
                      <span className="font-mono tabular-nums text-err">{t.errors} err</span>
                    ) : (
                      <span className="font-mono tabular-nums text-ok">0 err</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </motion.div>

        {/* --------------------------------------------------- calls list */}
        <motion.div variants={listItem}>
          <Card className="h-full">
            <CardHeader
              title={
                name ? (
                  <span>
                    Calls · <span className="font-mono">{name}</span>
                  </span>
                ) : (
                  'Recent calls'
                )
              }
              hint="round-trip is inferred wall time, includes client think time"
            />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={name ?? '(all)'}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {calls.isLoading ? (
                  <div className="space-y-2 p-3.5">
                    {Array.from({ length: 5 }, (_, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders, no data identity
                      <Skeleton key={i} className="h-12" />
                    ))}
                  </div>
                ) : (calls.data ?? []).length === 0 ? (
                  <div className="px-3.5 py-8 text-center text-[12px] text-ink-faint">
                    no calls returned
                  </div>
                ) : (
                  <div className="divide-y divide-line/50">
                    {(calls.data ?? []).map((c) => (
                      <div key={`${c.requestId}-${c.toolUseId}`} className="px-3.5 py-2">
                        <div className="flex items-center gap-2 text-[12px]">
                          <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                            {fmtTime(c.ts)}
                          </span>
                          <span className="font-mono font-semibold">{c.name}</span>
                          <Link
                            to={`/requests/${c.requestId}`}
                            className="font-mono text-[11px] text-accent hover:underline"
                          >
                            {shortId(c.requestId)}
                          </Link>
                          {c.resultObserved ? (
                            c.resultIsError ? (
                              <Badge tone="err">result: error</Badge>
                            ) : (
                              <Badge tone="ok">result observed</Badge>
                            )
                          ) : (
                            <Tip content="The matching tool_result never appeared in a later request through this proxy — the loop may have closed elsewhere.">
                              <span>
                                <Badge>no result seen</Badge>
                              </span>
                            </Tip>
                          )}
                          {c.roundTripMs != null ? (
                            <span className="ml-auto flex items-center gap-1.5 font-mono text-[11.5px] tabular-nums text-ink-dim">
                              {fmtMs(c.roundTripMs)} <InferredTag what="tool-round-trip" />
                            </span>
                          ) : null}
                        </div>
                        {c.inputJson ? (
                          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-canvas/60 px-2 py-1 font-mono text-[11.5px] text-ink-dim">
                            {c.inputJson.length > 400
                              ? `${c.inputJson.slice(0, 400)}…`
                              : c.inputJson}
                          </pre>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </Card>
        </motion.div>
      </motion.div>
    </Page>
  );
}
