import { openDatabase } from '@saga/store';

/** One-off profiler for the two bench stragglers. Not part of the suite. */
const db = openDatabase(process.argv[2]!, { readonly: true });
const NOW = Date.now();
const dayStart = new Date(NOW).setHours(0, 0, 0, 0);

const time = (name: string, fn: () => unknown): void => {
  fn();
  const t0 = performance.now();
  fn();
  console.log(`${(performance.now() - t0).toFixed(1).padStart(8)}ms  ${name}`);
};

time('today aggregate', () =>
  db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(input_tokens), GROUP_CONCAT(DISTINCT input_tokens_source),
              SUM(output_tokens), GROUP_CONCAT(DISTINCT output_tokens_source),
              SUM(CASE WHEN status = 'upstream_error' THEN 1 ELSE 0 END),
              SUM(cache_read_tokens), COUNT(cache_read_tokens)
       FROM requests WHERE ts >= ?`,
    )
    .get(dayStart),
);
time('today latencies sorted', () =>
  db
    .prepare(
      'SELECT latency_ms FROM requests WHERE ts >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms',
    )
    .all(dayStart),
);
time('active (status IS NULL)', () =>
  db.prepare('SELECT COUNT(*) AS n FROM requests WHERE status IS NULL').get(),
);
time('active sessions', () =>
  db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE last_activity_at >= ?').get(NOW - 300000),
);
time('sparkline 24h', () =>
  db
    .prepare(
      `SELECT (ts / 3600000) * 3600000 AS t, COUNT(*), SUM(output_tokens)
       FROM requests WHERE ts >= ? GROUP BY t ORDER BY t`,
    )
    .all(NOW - 86400000),
);
time('top models today', () =>
  db
    .prepare(
      `SELECT model, COUNT(*) AS n FROM requests WHERE ts >= ? AND model IS NOT NULL GROUP BY model ORDER BY n DESC LIMIT 5`,
    )
    .all(dayStart),
);
time('recent errors', () =>
  db
    .prepare(
      `SELECT request_id FROM requests WHERE status = 'upstream_error' ORDER BY ts DESC LIMIT 5`,
    )
    .all(),
);
console.log('--- storage pieces ---');
time('COUNT(*) requests', () => db.prepare('SELECT COUNT(*) AS n FROM requests').get());
time('COUNT(*) messages', () => db.prepare('SELECT COUNT(*) AS n FROM messages').get());
time('COUNT(*) sessions', () => db.prepare('SELECT COUNT(*) AS n FROM sessions').get());
time('tier group', () => db.prepare('SELECT tier, COUNT(*) FROM requests GROUP BY tier').all());
time('largest sessions 30d', () =>
  db
    .prepare(
      `SELECT session_id, SUM(request_bytes) AS b, COUNT(*) FROM requests WHERE ts >= ? GROUP BY session_id ORDER BY b DESC LIMIT 5`,
    )
    .all(NOW - 30 * 86400000),
);

for (const q of [
  `SELECT COUNT(*) FROM requests WHERE status IS NULL`,
  `SELECT tier, COUNT(*) FROM requests GROUP BY tier`,
]) {
  console.log(`\nEQP: ${q}`);
  for (const row of db.prepare(`EXPLAIN QUERY PLAN ${q}`).all()) {
    console.log(' ', JSON.stringify(row));
  }
}
db.close();
