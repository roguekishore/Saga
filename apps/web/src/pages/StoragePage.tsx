import {
  Card,
  CardHeader,
  EmptyState,
  fmtBytes,
  fmtDateTime,
  fmtInt,
  KpiCard,
  listContainer,
  listItem,
  NaValue,
  pct,
  Skeleton,
  shortId,
  Tip,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { Page } from '../shell/Page';

const TIER_HINT: Record<string, string> = {
  hot: 'full bodies, as captured',
  warm: 'bodies kept (already compressed at write)',
  cold: 'inputs dropped; system + response kept as the exchange summary',
  archive: 'all bodies dropped; metrics retained for analytics',
};

export function StoragePage() {
  const q = useQuery({ queryKey: ['storage'], queryFn: api.storage, refetchInterval: 15_000 });

  if (q.isLoading || !q.data) {
    return (
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders, no data identity
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );
  }
  const s = q.data;
  const ratio =
    s.compression.rawBytes > 0 ? s.compression.storedBytes / s.compression.rawBytes : null;

  return (
    <Page>
      {/* ------------------------------------------------------ KPI band */}
      <motion.div
        variants={listContainer}
        initial="initial"
        animate="animate"
        className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6"
      >
        {[
          <KpiCard
            key="db"
            label="database size"
            value={fmtBytes(s.dbSizeBytes)}
            sub={<span className="font-mono tabular-nums">wal {fmtBytes(s.walSizeBytes)}</span>}
          />,
          <KpiCard
            key="requests"
            label="requests"
            value={fmtInt(s.requestCount)}
            sub={<span className="font-mono tabular-nums">{fmtInt(s.sessionCount)} sessions</span>}
          />,
          <KpiCard
            key="messages"
            label="message rows"
            value={fmtInt(s.messageCount)}
            sub="after dedup"
          />,
          <KpiCard
            key="dedup"
            label="dedup savings"
            value={fmtBytes(s.dedupSavedBytes)}
            tone="ok"
            sub="bytes not written twice"
          />,
          <KpiCard
            key="compression"
            label="compression"
            value={
              ratio == null ? (
                <NaValue reason="No bodies stored yet." />
              ) : (
                `${pct(1 - ratio, 0)} saved`
              )
            }
            sub={
              ratio == null ? undefined : (
                <span>
                  <span className="font-mono tabular-nums">
                    {fmtBytes(s.compression.rawBytes)} → {fmtBytes(s.compression.storedBytes)}
                  </span>{' '}
                  (measured)
                </span>
              )
            }
          />,
          <KpiCard
            key="cleanup"
            label="last cleanup"
            value={
              s.retention.lastCleanupAt == null ? (
                <span className="text-[15px] text-ink-faint">never</span>
              ) : (
                <span className="font-mono text-[13px] tabular-nums">
                  {fmtDateTime(s.retention.lastCleanupAt)}
                </span>
              )
            }
            sub={
              s.retention.lastVacuumAt == null ? (
                'vacuum: never'
              ) : (
                <span>
                  vacuum:{' '}
                  <span className="font-mono tabular-nums">
                    {fmtDateTime(s.retention.lastVacuumAt)}
                  </span>
                </span>
              )
            }
          />,
        ].map((card, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed kpi order, position is identity
          <motion.div key={i} variants={listItem}>
            {card}
          </motion.div>
        ))}
      </motion.div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ------------------------------------------------ retention tiers */}
        <Card>
          <CardHeader
            title="Retention tiers"
            hint={`hot ${s.retention.hotDays}d · warm ${s.retention.warmDays}d · cold ${s.retention.coldDays}d · weekly cleanup`}
          />
          <div className="space-y-2.5 px-3.5 pb-3.5">
            {s.tiers.map((t) => {
              const total = Math.max(1, s.requestCount);
              return (
                <Tip key={t.tier} content={TIER_HINT[t.tier] ?? t.tier}>
                  <div className="cursor-default">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                        {t.tier}
                      </span>
                      <span className="font-mono text-[11.5px] tabular-nums text-ink-dim">
                        {fmtInt(t.requests)} ({pct(t.requests / total, 0)})
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                      <div
                        className="h-full rounded-full bg-accent/70"
                        style={{ width: `${Math.max(1, (t.requests / total) * 100)}%` }}
                      />
                    </div>
                  </div>
                </Tip>
              );
            })}
            <p className="pt-1 text-[11px] leading-4 text-ink-faint">
              Deleted prompt bodies linger in SQLite freelist pages until VACUUM — the cleanup pass
              vacuums when the freelist crosses 10% of the file, so retention actually deletes.
            </p>
          </div>
        </Card>

        {/* ------------------------------------------------ largest sessions */}
        <Card>
          <CardHeader title="Largest sessions" hint="by request payload bytes, last 7 days" />
          <div className="px-1.5 pb-3">
            {s.largestSessions.length === 0 ? (
              <EmptyState icon={<Database />} title="Nothing stored yet" className="m-2 border-0">
                Sessions rank by captured request payload bytes over the last 7 days — they fill in
                as traffic flows through the proxy.
              </EmptyState>
            ) : (
              s.largestSessions.map((l) => (
                <div
                  key={l.sessionId}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors duration-(--dur-1) hover:bg-raised/60"
                >
                  <Link
                    to={`/sessions/${l.sessionId}`}
                    className="font-mono text-[12px] text-accent hover:underline"
                  >
                    {shortId(l.sessionId)}
                  </Link>
                  <span className="font-mono text-[12px] tabular-nums text-ink-dim">
                    {fmtInt(l.requests)} req · {fmtBytes(l.bytes)}
                  </span>
                </div>
              ))
            )}
            <p className="px-2 pt-2 text-[11px] leading-4 text-ink-faint">
              Snapshots go through <code className="font-mono">VACUUM INTO</code>, never a file copy
              — copying a live WAL database tears it.
            </p>
          </div>
        </Card>
      </div>
    </Page>
  );
}
