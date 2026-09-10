import type { Driver } from '@saga/store';

const DAY = 86_400_000;

/**
 * Incremental daily rollup. Rebuilds only days at/after the watermark (the
 * watermark day itself is always rebuilt — it was partial when last summed).
 * Steady-state cost: one day of rows, single-digit ms. First run after a
 * bulk import pays once for the backlog.
 */
export function ensureDailyRollup(db: Driver, now: number = Date.now()): void {
  try {
    ensureDailyRollupOrThrow(db, now);
  } catch {
    // Read-only connection or lock contention: serve the existing rollup
    // rather than failing the query. Staleness is bounded by the writer's
    // own refresh cycle.
  }
}

function ensureDailyRollupOrThrow(db: Driver, now: number): void {
  const wm = db.prepare<{ v: string }>(`SELECT v FROM meta WHERE k = 'rollup_thru_day'`).get();
  const oldest = db.prepare<{ t: number | null }>('SELECT MIN(ts) AS t FROM requests').get();
  if (oldest?.t == null) return;

  const startDay = wm == null ? Math.floor(oldest.t / DAY) * DAY : Number(wm.v); // rebuild watermark day
  const today = Math.floor(now / DAY) * DAY;
  if (wm != null && startDay > today) return;

  db.transaction(() => {
    db.prepare('DELETE FROM stats_daily WHERE day >= ?').run(startDay);
    db.prepare(
      `INSERT INTO stats_daily (
         day, model, adapter_id, requests, errors, input_sum, output_sum,
         in_sources, out_sources, latency_sum, latency_count, ttft_sum, ttft_count
       )
       SELECT (ts / ${DAY}) * ${DAY} AS day,
              COALESCE(model, '(none)'),
              adapter_id,
              COUNT(*),
              SUM(CASE WHEN status = 'upstream_error' THEN 1 ELSE 0 END),
              COALESCE(SUM(input_tokens), 0),
              COALESCE(SUM(output_tokens), 0),
              COALESCE(GROUP_CONCAT(DISTINCT input_tokens_source), ''),
              COALESCE(GROUP_CONCAT(DISTINCT output_tokens_source), ''),
              COALESCE(SUM(latency_ms), 0),
              COUNT(latency_ms),
              COALESCE(SUM(ttft_ms), 0),
              COUNT(ttft_ms)
       FROM requests WHERE ts >= ?
       GROUP BY day, COALESCE(model, '(none)'), adapter_id`,
    ).run(startDay);
    db.prepare(
      `INSERT INTO meta (k, v) VALUES ('rollup_thru_day', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(String(today));
  });
}
