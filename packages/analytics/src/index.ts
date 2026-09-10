import type {
  AggUsage,
  ContextGrowth,
  LatencySeries,
  Provenance,
  TokenSeries,
} from '@saga/contracts';
import type { Driver } from '@saga/store';
import { ensureDailyRollup } from './rollup';

export { ensureDailyRollup } from './rollup';

/**
 * Analytics live behind this interface from the very first query — that is
 * what keeps the DuckDB swap possible. Whether the swap happens is decided by
 * W7's benchmark on a year-sized corpus, not by preference. The SQLite
 * implementation is the only one until that benchmark says otherwise.
 */
export interface AnalyticsBackend {
  tokenSeries(q: {
    from: number;
    to: number;
    bucket: 'hour' | 'day';
    groupBy: 'none' | 'model' | 'adapterId' | 'agentId';
  }): TokenSeries;
  latencySeries(q: { from: number; to: number; bucket: 'hour' | 'day' }): LatencySeries;
  contextGrowth(sessionId: string): ContextGrowth;
}

const BUCKET_MS = { hour: 3_600_000, day: 86_400_000 } as const;
const GROUP_COL = { model: 'model', adapterId: 'adapter_id', agentId: 'agent_id' } as const;

function agg(sum: unknown, sources: unknown): AggUsage {
  const value = typeof sum === 'number' ? Math.max(0, Math.floor(sum)) : 0;
  const list =
    typeof sources === 'string' && sources.length > 0
      ? ([...new Set(sources.split(','))] as Provenance[])
      : [];
  return { value, sources: list };
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export class SqliteAnalytics implements AnalyticsBackend {
  constructor(private readonly db: Driver) {}

  tokenSeries(q: {
    from: number;
    to: number;
    bucket: 'hour' | 'day';
    groupBy: 'none' | 'model' | 'adapterId' | 'agentId';
  }): TokenSeries {
    // Day buckets come from the rollup (bench: raw year scan 550-700ms vs
    // 200ms target). Hour buckets and agent grouping stay raw — ranges are
    // short and agents are not a rollup dimension.
    if (q.bucket === 'day' && q.groupBy !== 'agentId') {
      return this.tokenSeriesFromRollup(q.from, q.to, q.groupBy);
    }
    const ms = BUCKET_MS[q.bucket];
    const groupCol = q.groupBy === 'none' ? null : GROUP_COL[q.groupBy];
    const groupSel = groupCol ? `, COALESCE(${groupCol}, '(none)') AS grp` : `, NULL AS grp`;
    const groupBy = groupCol ? ', grp' : '';
    const rows = this.db
      .prepare<{
        t: number;
        grp: string | null;
        in_sum: number | null;
        in_src: string | null;
        out_sum: number | null;
        out_src: string | null;
        n: number;
      }>(
        `SELECT (ts / ${ms}) * ${ms} AS t${groupSel},
                SUM(input_tokens) AS in_sum,
                GROUP_CONCAT(DISTINCT input_tokens_source) AS in_src,
                SUM(output_tokens) AS out_sum,
                GROUP_CONCAT(DISTINCT output_tokens_source) AS out_src,
                COUNT(*) AS n
         FROM requests WHERE ts >= ? AND ts < ?
         GROUP BY t${groupBy} ORDER BY t`,
      )
      .all(q.from, q.to);
    return {
      series: rows.map((r) => ({
        t: r.t,
        group: r.grp,
        input: agg(r.in_sum, r.in_src),
        output: agg(r.out_sum, r.out_src),
        requests: r.n,
      })),
    };
  }

  private tokenSeriesFromRollup(
    from: number,
    to: number,
    groupBy: 'none' | 'model' | 'adapterId',
  ): TokenSeries {
    ensureDailyRollup(this.db);
    const groupSel =
      groupBy === 'model'
        ? ', model AS grp'
        : groupBy === 'adapterId'
          ? ', adapter_id AS grp'
          : ', NULL AS grp';
    const groupClause = groupBy === 'none' ? '' : ', grp';
    const rows = this.db
      .prepare<{
        t: number;
        grp: string | null;
        in_sum: number;
        in_src: string;
        out_sum: number;
        out_src: string;
        n: number;
      }>(
        `SELECT day AS t${groupSel},
                SUM(input_sum) AS in_sum,
                GROUP_CONCAT(DISTINCT in_sources) AS in_src,
                SUM(output_sum) AS out_sum,
                GROUP_CONCAT(DISTINCT out_sources) AS out_src,
                SUM(requests) AS n
         FROM stats_daily WHERE day >= ? AND day < ?
         GROUP BY t${groupClause} ORDER BY t`,
      )
      .all(from, to);
    return {
      series: rows.map((r) => ({
        t: r.t,
        group: r.grp,
        input: agg(r.in_sum, r.in_src),
        output: agg(r.out_sum, r.out_src),
        requests: r.n,
      })),
    };
  }

  latencySeries(q: { from: number; to: number; bucket: 'hour' | 'day' }): LatencySeries {
    // Beyond 90 days, percentiles over raw rows blow the budget; the rollup
    // serves honest averages and the UI renders p50/p95 as absent rather
    // than inventing them from sums.
    if (q.bucket === 'day' && q.to - q.from > 90 * 86_400_000) {
      return this.latencySeriesFromRollup(q.from, q.to);
    }
    const ms = BUCKET_MS[q.bucket];
    const rows = this.db
      .prepare<{ t: number; latency: number; ttft: number | null }>(
        `SELECT (ts / ${ms}) * ${ms} AS t, latency_ms AS latency, ttft_ms AS ttft
         FROM requests
         WHERE ts >= ? AND ts < ? AND latency_ms IS NOT NULL
         ORDER BY t`,
      )
      .all(q.from, q.to);

    const buckets = new Map<number, { lat: number[]; ttft: number[] }>();
    for (const r of rows) {
      const b = buckets.get(r.t) ?? { lat: [], ttft: [] };
      b.lat.push(r.latency);
      if (r.ttft != null) b.ttft.push(r.ttft);
      buckets.set(r.t, b);
    }
    const series = [...buckets.entries()].map(([t, b]) => {
      const sorted = [...b.lat].sort((x, y) => x - y);
      const avg = sorted.reduce((a, v) => a + v, 0) / sorted.length;
      const avgTtft = b.ttft.length ? b.ttft.reduce((a, v) => a + v, 0) / b.ttft.length : null;
      return {
        t,
        avg,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        avgTtft,
        count: sorted.length,
      };
    });

    const sample = this.db
      .prepare<{
        ts: number;
        latencyMs: number;
        ttftMs: number | null;
        outputTokens: number | null;
        model: string | null;
        requestId: string;
      }>(
        `SELECT ts, latency_ms AS latencyMs, ttft_ms AS ttftMs, output_tokens AS outputTokens,
                model, request_id AS requestId
         FROM requests
         WHERE ts >= ? AND ts < ? AND latency_ms IS NOT NULL
         ORDER BY ts DESC LIMIT 1000`,
      )
      .all(q.from, q.to);

    return { series, sample };
  }

  private latencySeriesFromRollup(from: number, to: number): LatencySeries {
    ensureDailyRollup(this.db);
    const rows = this.db
      .prepare<{
        t: number;
        lat_sum: number;
        lat_n: number;
        ttft_sum: number;
        ttft_n: number;
      }>(
        `SELECT day AS t, SUM(latency_sum) AS lat_sum, SUM(latency_count) AS lat_n,
                SUM(ttft_sum) AS ttft_sum, SUM(ttft_count) AS ttft_n
         FROM stats_daily WHERE day >= ? AND day < ? GROUP BY day ORDER BY day`,
      )
      .all(from, to);
    const sample = this.db
      .prepare<{
        ts: number;
        latencyMs: number;
        ttftMs: number | null;
        outputTokens: number | null;
        model: string | null;
        requestId: string;
      }>(
        `SELECT ts, latency_ms AS latencyMs, ttft_ms AS ttftMs, output_tokens AS outputTokens,
                model, request_id AS requestId
         FROM requests WHERE ts >= ? AND ts < ? AND latency_ms IS NOT NULL
         ORDER BY ts DESC LIMIT 1000`,
      )
      .all(from, to);
    return {
      series: rows.map((r) => ({
        t: r.t,
        avg: r.lat_n > 0 ? r.lat_sum / r.lat_n : null,
        p50: null, // not derivable from sums; absent beats invented
        p95: null,
        avgTtft: r.ttft_n > 0 ? r.ttft_sum / r.ttft_n : null,
        count: r.lat_n,
      })),
      sample,
    };
  }

  contextGrowth(sessionId: string): ContextGrowth {
    const rows = this.db
      .prepare<{
        requestId: string;
        ts: number;
        turn: number;
        inTok: number | null;
        inSrc: string | null;
        outTok: number | null;
        outSrc: string | null;
        messageCount: number;
        requestBytes: number;
      }>(
        `SELECT request_id AS requestId, ts,
                ROW_NUMBER() OVER (ORDER BY ts, request_id) AS turn,
                input_tokens AS inTok, input_tokens_source AS inSrc,
                output_tokens AS outTok, output_tokens_source AS outSrc,
                message_count AS messageCount, request_bytes AS requestBytes
         FROM requests WHERE session_id = ? ORDER BY ts, request_id`,
      )
      .all(sessionId);
    return {
      sessionId,
      points: rows.map((r) => ({
        requestId: r.requestId,
        ts: r.ts,
        turn: r.turn,
        inputTokens:
          r.inTok != null && r.inSrc != null
            ? { value: r.inTok, source: r.inSrc as Provenance }
            : null,
        outputTokens:
          r.outTok != null && r.outSrc != null
            ? { value: r.outTok, source: r.outSrc as Provenance }
            : null,
        messageCount: r.messageCount,
        requestBytes: r.requestBytes,
      })),
    };
  }
}
