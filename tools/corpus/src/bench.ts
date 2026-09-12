import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SqliteAnalytics } from '@saga/analytics';
import { getOverview, getStorageInfo, listRequests, listSessions, searchMessages } from '@saga/api';
import { MIGRATIONS, openDatabase, runMigrations, runRetention, StoreWriter } from '@saga/store';

/**
 * The P2 gate benchmark: analytics latency on a YEAR-sized corpus
 * (~2,500 requests/day ≈ 912k requests — the master plan's own sizing).
 * This measurement, not preference, decides whether DuckDB earns a seat
 * behind the query interface.
 *
 *   bun tools/corpus/src/bench.ts [dbPath] [--keep]
 *
 * Part 1 measures real StoreWriter throughput (target >5,000 events/sec).
 * Part 2 bulk-loads the year corpus with direct prepared statements (the
 * writer path is measured in part 1; bulk load just builds the dataset),
 * then times every read the dashboard actually issues (target <200ms,
 * search <100ms).
 */

const dbPath = process.argv[2] ?? join(tmpdir(), 'saga-bench', 'bench.db');
const keep = process.argv.includes('--keep');

const DAY = 86_400_000;
const NOW = Date.now();
const DAYS = 365;
const REQ_PER_DAY = 2_500;
const SESSIONS_PER_DAY = 40;

mkdirSync(dirname(dbPath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
}
const db = openDatabase(dbPath);
runMigrations(db, MIGRATIONS);

// --------------------------------------------------- part 1: writer rate
{
  const writer = new StoreWriter(db);
  const N = 5_000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const rid = `req_thr_${i}`;
    const ts = NOW - 3_600_000 + i * 100;
    writer.handleEvent({
      kind: 'request_started',
      requestId: rid,
      ts,
      sessionId: `ses_thr_${i % 50}`,
      sessionIdSource: 'inferred',
      clientSessionId: null,
      adapterId: 'anthropic',
      provider: 'anthropic-messages',
      endpoint: '/v1/messages',
      method: 'POST',
      upstreamUrl: 'http://bench',
      clientName: 'bench',
      workspace: null,
      model: 'claude-sonnet-4',
      stream: true,
      request: {
        model: 'claude-sonnet-4',
        stream: true,
        system: [
          {
            role: 'system',
            blocks: [{ type: 'text', text: 'shared bench system prompt for dedup' }],
            contextSource: 'system',
            contextSourceInferred: false,
          },
        ],
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'text', text: `bench turn ${i} — measure the write path honestly` }],
            contextSource: 'user',
            contextSourceInferred: false,
          },
        ],
        tools: [],
        paramsJson: '{"max_tokens":512}',
        rawRequestJson: `{"bench":${i},"pad":"${'p'.repeat(400)}"}`,
      },
      redaction: { hits: [], flagged: false },
      // WS-C hierarchy fields. Explicit because `z.default()` is input-optional
      // but OUTPUT-required. Left unclassified (turn/callRole null) on purpose:
      // this benchmark measures the WRITE PATH, and inventing turn structure here
      // would measure a fiction rather than what capture actually produces today.
      door: 'A',
      harness: 'claude-code',
      routingTier: null,
      turn: null,
      callRole: null,
      harnessIdentity: null,
      injections: [],
    });
    writer.handleEvent({
      kind: 'response_finished',
      requestId: rid,
      ts: ts + 400,
      status: 'ok',
      httpStatus: 200,
      latencyMs: 400,
      ttftMs: 90,
      usage: {
        input: { value: 500, source: 'gateway-computed' },
        output: { value: 60, source: 'gateway-computed' },
        cacheRead: null,
        cacheWrite: null,
      },
      stopReason: 'end_turn',
      message: {
        role: 'assistant',
        blocks: [{ type: 'text', text: `bench answer ${i % 25}` }],
        contextSource: 'assistant',
        contextSourceInferred: false,
      },
      error: null,
      frameStats: { frames: 6, bytes: 900, parseErrors: 0 },
      redaction: { hits: [], flagged: false },
    });
  }
  const secs = (performance.now() - t0) / 1000;
  const eventsPerSec = Math.round((N * 2) / secs);
  console.log(
    `[bench] writer throughput: ${N * 2} events in ${secs.toFixed(2)}s = ${eventsPerSec} events/sec (target >5000)`,
  );
}

// ------------------------------------------- part 2: year-sized dataset
{
  console.log(
    `[bench] bulk-loading ~${(DAYS * REQ_PER_DAY).toLocaleString()} requests over ${DAYS} days…`,
  );
  const t0 = performance.now();

  const insSession = db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, started_at, last_activity_at, client_name, workspace)
     VALUES (?, ?, ?, 'bench-client', '/bench/workspace')`,
  );
  const insMsg = db.prepare(
    `INSERT INTO messages (content_hash, role, kind, body, compressed, raw_bytes, stored_bytes, refs, created_at)
     VALUES (?, ?, 'message', ?, 0, ?, ?, 1, ?)
     ON CONFLICT(content_hash) DO UPDATE SET refs = messages.refs + 1
     RETURNING id, refs`,
  );
  const insFts = db.prepare(`INSERT INTO messages_fts (rowid, content) VALUES (?, ?)`);
  const insReq = db.prepare(
    `INSERT INTO requests (
       request_id, session_id, ts, adapter_id, provider, endpoint, method, model, stream,
       status, http_status, latency_ms, ttft_ms,
       input_tokens, input_tokens_source, output_tokens, output_tokens_source,
       message_count, tool_use_count, redaction_hits_json, request_bytes, params_json, tools_json, tier
     ) VALUES (?, ?, ?, 'anthropic', 'anthropic-messages', '/v1/messages', 'POST', ?, 1,
       ?, ?, ?, ?, ?, 'gateway-computed', ?, 'gateway-computed', ?, 0, '[]', ?, '{}', '[]', 'hot')`,
  );
  const insLink = db.prepare(
    `INSERT INTO request_messages (request_id, seq, message_id, segment, context_source, context_source_inferred)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );

  const MODELS = ['claude-sonnet-4', 'claude-haiku-3', 'claude-opus-4'];
  const TOPICS = [
    'retention tiers and archive semantics',
    'websocket fan out backpressure',
    'sqlite strict tables and rowid design',
    'brotli compression thresholds',
    'adapter normalization for tool blocks',
    'session correlation heuristics',
    'redaction entropy backstop tuning',
    'latency percentiles per bucket',
    'dedup reference counting',
    'proxy tee and client isolation',
    'migration create copy drop rename',
    'keyset pagination cursors',
  ];
  let reqCount = 0;
  const enc = new TextEncoder();

  const storeMsg = (text: string, role: string, ts: number): number => {
    const body = enc.encode(JSON.stringify({ role, blocks: [{ type: 'text', text }] }));
    const hash = `bench-${Bun.hash(text).toString(16)}-${role}`;
    const row = insMsg.get(hash, role, body, body.byteLength, body.byteLength, ts) as {
      id: number;
      refs: number;
    } | null;
    if (row && row.refs === 1) insFts.run(row.id, text);
    return row?.id ?? 0;
  };

  for (let day = DAYS; day > 0; day--) {
    db.transaction(() => {
      const dayStart = NOW - day * DAY;
      const turnsPerSession = Math.ceil(REQ_PER_DAY / SESSIONS_PER_DAY);
      for (let s = 0; s < SESSIONS_PER_DAY; s++) {
        const sid = `ses_b_${day}_${s}`;
        insSession.run(
          sid,
          dayStart + s * 60_000,
          dayStart + s * 60_000 + turnsPerSession * 30_000,
        );
        const sysId = storeMsg(
          `bench system prompt for session bucket ${s % 6}`,
          'system',
          dayStart,
        );
        for (let t = 0; t < turnsPerSession; t++) {
          const rid = `req_b_${day.toString().padStart(3, '0')}_${s}_${t}`;
          const ts = dayStart + s * 60_000 + t * 30_000;
          const model = MODELS[(s + t) % 3]!;
          const latency = 400 + ((s * 37 + t * 91) % 4000);
          const isErr = (s * t) % 97 === 0 && t > 0;
          const inputTok = 800 + t * 120;
          const outputTok = 40 + ((t * 53) % 400);
          insReq.run(
            rid,
            sid,
            ts,
            model,
            isErr ? 'upstream_error' : 'ok',
            isErr ? 529 : 200,
            latency,
            80 + (latency % 300),
            inputTok,
            outputTok,
            2 + t,
            700 + t * 90,
          );
          reqCount++;
          // Realistic term selectivity: common words everywhere, the bench
          // search terms ('freelist', 'vacuum') on ~0.5% of docs. A corpus
          // where the probe term matches EVERY doc benchmarks nothing real.
          const rare = (s * 63 + t) % 211 === 0 ? ' vacuum freelist pages behavior' : '';
          const userId = storeMsg(
            `day ${day} session ${s} turn ${t}: question about ${TOPICS[(s + t) % TOPICS.length]}${rare}`,
            'user',
            ts,
          );
          const asstId = storeMsg(
            `bench assistant answer variant ${(s + t) % 40}`,
            'assistant',
            ts,
          );
          insLink.run(rid, 0, sysId, 'system', 'system');
          insLink.run(rid, 1, userId, 'input', 'user');
          insLink.run(rid, 1_000_000, asstId, 'output', 'assistant');
        }
      }
    });
    if (day % 60 === 0) console.log(`[bench]   … ${reqCount.toLocaleString()} requests loaded`);
  }
  const secs = (performance.now() - t0) / 1000;
  console.log(
    `[bench] loaded ${reqCount.toLocaleString()} requests in ${secs.toFixed(1)}s; db=${(statSync(dbPath).size / 1e9).toFixed(2)}GB`,
  );
}

// ---------------------------------------------------- part 3: query times
{
  const analytics = new SqliteAnalytics(db);
  const timings: Array<{ name: string; ms: number; target: number }> = [];
  const time = (name: string, target: number, fn: () => unknown): void => {
    fn(); // warm
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      fn();
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    timings.push({ name, ms: runs[1]!, target });
  };

  const bigSession = db
    .prepare<{ session_id: string }>(
      `SELECT session_id FROM requests GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get()!.session_id;

  time('overview (today KPIs)', 200, () => getOverview(db, NOW));
  time('token series, 365d day buckets', 200, () =>
    analytics.tokenSeries({ from: NOW - 365 * DAY, to: NOW, bucket: 'day', groupBy: 'none' }),
  );
  time('token series, 365d by model', 200, () =>
    analytics.tokenSeries({ from: NOW - 365 * DAY, to: NOW, bucket: 'day', groupBy: 'model' }),
  );
  time('latency series, 30d day buckets', 200, () =>
    analytics.latencySeries({ from: NOW - 30 * DAY, to: NOW, bucket: 'day' }),
  );
  time('latency series, 7d hour buckets', 200, () =>
    analytics.latencySeries({ from: NOW - 7 * DAY, to: NOW, bucket: 'hour' }),
  );
  time('request list page (100)', 200, () => listRequests(db, { limit: 100 }));
  time('request list, session filter', 200, () =>
    listRequests(db, { limit: 100, sessionId: bigSession }),
  );
  time('session list (50, aggregated)', 200, () => listSessions(db, 50));
  time('context growth, largest session', 200, () => analytics.contextGrowth(bigSession));
  time('FTS search, single term', 100, () => searchMessages(db, 'freelist', 25));
  time('FTS search, phrase', 100, () => searchMessages(db, 'vacuum freelist pages', 25));
  time('storage info', 200, () =>
    getStorageInfo(db, dbPath, { hotDays: 30, warmDays: 90, coldDays: 180 }),
  );

  const reqTotal = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM requests').get()!.n;
  const msgTotal = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM messages').get()!.n;

  console.log(
    `\n[bench] corpus: ${reqTotal.toLocaleString()} requests, ${msgTotal.toLocaleString()} messages`,
  );
  console.log('┌──────────────────────────────────────┬──────────┬────────┬──────┐');
  console.log('│ query                                │  median  │ target │ ok?  │');
  console.log('├──────────────────────────────────────┼──────────┼────────┼──────┤');
  let allOk = true;
  for (const t of timings) {
    const ok = t.ms <= t.target;
    allOk &&= ok;
    console.log(
      `│ ${t.name.padEnd(36)} │ ${`${t.ms.toFixed(1)}ms`.padStart(8)} │ ${`${t.target}ms`.padStart(6)} │ ${ok ? ' ✓ ' : ' ✗ '}  │`,
    );
  }
  console.log('└──────────────────────────────────────┴──────────┴────────┴──────┘');

  const t0 = performance.now();
  const report = runRetention(
    db,
    { hotDays: 30, warmDays: 90, coldDays: 180, vacuumFreelistRatio: 0.05 },
    NOW,
  );
  console.log(
    `[bench] retention pass on year corpus: ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
      `(tiered w/c/a=${report.tiered.warm}/${report.tiered.cold}/${report.tiered.archive}, ` +
      `msgs deleted=${report.messagesDeleted}, vacuumed=${report.vacuumed})`,
  );

  console.log(
    allOk
      ? '\n[bench] VERDICT: all queries inside target — DuckDB not justified by this corpus.'
      : '\n[bench] VERDICT: targets missed — see table; a measured DuckDB case exists.',
  );
}

db.close();
if (!keep) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }
  console.log('[bench] cleaned up bench database');
}
