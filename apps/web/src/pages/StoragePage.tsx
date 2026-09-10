import {
  Card,
  CardHeader,
  fmtBytes,
  fmtDateTime,
  fmtInt,
  KpiCard,
  NaValue,
  pct,
  Skeleton,
  shortId,
  Tip,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api';

const TIER_HINT: Record<string, string> = {
  hot: 'full bodies, as captured',
  warm: 'bodies kept (already compressed at write)',
  cold: 'inputs dropped; system + response kept as the exchange summary',
  archive: 'all bodies dropped; metrics retained for analytics',
};

export function StoragePage() {
  const q = useQuery({ queryKey: ['storage'], queryFn: api.storage, refetchInterval: 15_000 });

  if (q.isLoading || !q.data) return <Skeleton className="m-4 h-72" />;
  const s = q.data;
  const ratio =
    s.compression.rawBytes > 0 ? s.compression.storedBytes / s.compression.rawBytes : null;

  return (
    <div className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <KpiCard
          label="database size"
          value={fmtBytes(s.dbSizeBytes)}
          sub={`wal ${fmtBytes(s.walSizeBytes)}`}
        />
        <KpiCard
          label="requests"
          value={fmtInt(s.requestCount)}
          sub={`${fmtInt(s.sessionCount)} sessions`}
        />
        <KpiCard label="message rows" value={fmtInt(s.messageCount)} sub="after dedup" />
        <KpiCard
          label="dedup savings"
          value={fmtBytes(s.dedupSavedBytes)}
          tone="ok"
          sub="bytes not written twice"
        />
        <KpiCard
          label="compression"
          value={
            ratio == null ? (
              <NaValue reason="No bodies stored yet." />
            ) : (
              `${pct(1 - ratio, 0)} saved`
            )
          }
          sub={
            ratio == null
              ? undefined
              : `${fmtBytes(s.compression.rawBytes)} → ${fmtBytes(s.compression.storedBytes)} (measured)`
          }
        />
        <KpiCard
          label="last cleanup"
          value={
            s.retention.lastCleanupAt == null ? (
              <span className="text-[15px] text-ink-faint">never</span>
            ) : (
              <span className="text-[15px]">{fmtDateTime(s.retention.lastCleanupAt)}</span>
            )
          }
          sub={
            s.retention.lastVacuumAt == null
              ? 'vacuum: never'
              : `vacuum: ${fmtDateTime(s.retention.lastVacuumAt)}`
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Retention tiers"
            hint={`hot ${s.retention.hotDays}d · warm ${s.retention.warmDays}d · cold ${s.retention.coldDays}d · weekly cleanup`}
          />
          <div className="space-y-2 px-3.5 pb-3.5">
            {s.tiers.map((t) => {
              const total = Math.max(1, s.requestCount);
              return (
                <Tip key={t.tier} content={TIER_HINT[t.tier] ?? t.tier}>
                  <div className="cursor-default">
                    <div className="flex justify-between text-[12px]">
                      <span className="font-medium">{t.tier}</span>
                      <span className="tabular-nums text-ink-dim">
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

        <Card>
          <CardHeader title="Largest sessions" hint="by request payload bytes, last 7 days" />
          <div className="px-3.5 pb-3.5">
            {s.largestSessions.length === 0 ? (
              <div className="py-3 text-[12px] text-ink-faint">nothing stored yet</div>
            ) : (
              s.largestSessions.map((l) => (
                <div key={l.sessionId} className="flex items-center justify-between gap-2 py-1.5">
                  <Link
                    to={`/sessions/${l.sessionId}`}
                    className="font-mono text-[12px] text-accent hover:underline"
                  >
                    {shortId(l.sessionId)}
                  </Link>
                  <span className="text-[12px] tabular-nums text-ink-dim">
                    {fmtInt(l.requests)} req · {fmtBytes(l.bytes)}
                  </span>
                </div>
              ))
            )}
            <p className="pt-2 text-[11px] leading-4 text-ink-faint">
              Snapshots go through <code className="font-mono">VACUUM INTO</code>, never a file copy
              — copying a live WAL database tears it.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
