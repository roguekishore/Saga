import { existsSync, statSync } from 'node:fs';
import { percentile } from '@saga/analytics';
import {
  type AggUsage,
  type NormalizedMessage,
  NormalizedMessageSchema,
  type Overview,
  type Provenance,
  type RequestDetail,
  type RequestList,
  type RequestListQuery,
  type RequestSummary,
  type SearchResult,
  type SessionList,
  type SessionSummary,
  type StorageInfo,
  type UsageValue,
} from '@saga/contracts';
import { type Driver, decodeBody } from '@saga/store';

/** Read-side row mapping. Every shape returned here is a frozen contract. */

type Row = Record<string, unknown>;

function uv(value: unknown, source: unknown): UsageValue | null {
  return typeof value === 'number' && typeof source === 'string'
    ? { value, source: source as Provenance }
    : null;
}

function aggFrom(sum: unknown, srcCsv: unknown): AggUsage {
  return {
    value: typeof sum === 'number' ? Math.max(0, Math.floor(sum)) : 0,
    sources:
      typeof srcCsv === 'string' && srcCsv.length
        ? ([...new Set(srcCsv.split(','))] as Provenance[])
        : [],
  };
}

function rowToSummary(r: Row): RequestSummary {
  return {
    requestId: String(r.request_id),
    ts: Number(r.ts),
    sessionId: String(r.session_id),
    adapterId: String(r.adapter_id),
    provider: String(r.provider),
    model: (r.model as string | null) ?? null,
    endpoint: String(r.endpoint),
    stream: r.stream === 1,
    status: (r.status as RequestSummary['status']) ?? null,
    httpStatus: (r.http_status as number | null) ?? null,
    latencyMs: (r.latency_ms as number | null) ?? null,
    ttftMs: (r.ttft_ms as number | null) ?? null,
    inputTokens: uv(r.input_tokens, r.input_tokens_source),
    outputTokens: uv(r.output_tokens, r.output_tokens_source),
    messageCount: Number(r.message_count ?? 0),
    toolUseCount: Number(r.tool_use_count ?? 0),
    agentId: (r.agent_id as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    redactionFlagged: r.redaction_flagged === 1,
  };
}

export function listRequests(db: Driver, q: RequestListQuery): RequestList {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.sessionId) {
    where.push('session_id = ?');
    params.push(q.sessionId);
  }
  if (q.agentId) {
    where.push('agent_id = ?');
    params.push(q.agentId);
  }
  if (q.model) {
    where.push('model = ?');
    params.push(q.model);
  }
  if (q.adapterId) {
    where.push('adapter_id = ?');
    params.push(q.adapterId);
  }
  if (q.status) {
    where.push('status = ?');
    params.push(q.status);
  }
  if (q.from != null) {
    where.push('ts >= ?');
    params.push(q.from);
  }
  if (q.to != null) {
    where.push('ts <= ?');
    params.push(q.to);
  }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString('utf-8').split('|');
    where.push('(ts < ? OR (ts = ? AND request_id < ?))');
    params.push(Number(ts), Number(ts), id ?? '');
  }
  const sql = `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ts DESC, request_id DESC LIMIT ?`;
  const rows = db.prepare<Row>(sql).all(...params, q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > q.limit && last
      ? Buffer.from(`${last.ts}|${last.request_id}`, 'utf-8').toString('base64url')
      : null;
  return { items: page.map(rowToSummary), nextCursor };
}

function decodeMessage(row: Row, contextSource: string, inferred: unknown): NormalizedMessage {
  const canonical = JSON.parse(decodeBody(row.body as Uint8Array, row.compressed === 1)) as {
    role: string;
    blocks: unknown[];
  };
  return NormalizedMessageSchema.parse({
    role: canonical.role,
    blocks: canonical.blocks,
    contextSource,
    contextSourceInferred: inferred === 1,
    // messages.created_at survives dedup by design -- the ON CONFLICT path
    // bumps refs and leaves it alone -- so it dates the FIRST request to carry
    // this exact body. Older than this request's ts means carried-over context.
    firstObservedAt: typeof row.created_at === 'number' ? row.created_at : null,
  });
}

export function getRequestDetail(db: Driver, requestId: string): RequestDetail | null {
  const r = db.prepare<Row>('SELECT * FROM requests WHERE request_id = ?').get(requestId);
  if (!r) return null;

  const links = db
    .prepare<Row>(
      `SELECT rm.segment, rm.context_source, rm.context_source_inferred,
              m.body, m.compressed, m.created_at
       FROM request_messages rm JOIN messages m ON m.id = rm.message_id
       WHERE rm.request_id = ? ORDER BY rm.seq`,
    )
    .all(requestId);

  const system: NormalizedMessage[] = [];
  const input: NormalizedMessage[] = [];
  let output: NormalizedMessage | null = null;
  for (const link of links) {
    const msg = decodeMessage(link, String(link.context_source), link.context_source_inferred);
    if (link.segment === 'system') system.push(msg);
    else if (link.segment === 'input') input.push(msg);
    else output = msg;
  }

  let rawRequestJson = 'null';
  if (r.raw_request_msg_id != null) {
    const raw = db
      .prepare<Row>('SELECT body, compressed FROM messages WHERE id = ?')
      .get(r.raw_request_msg_id as number);
    if (raw) {
      const canonical = JSON.parse(decodeBody(raw.body as Uint8Array, raw.compressed === 1)) as {
        blocks: Array<{ type: string; text?: string }>;
      };
      rawRequestJson = canonical.blocks[0]?.text ?? 'null';
    }
  }

  const summary = rowToSummary(r);
  const ttft = summary.ttftMs;
  return {
    summary,
    request: {
      model: summary.model,
      stream: summary.stream,
      system,
      messages: input,
      tools: JSON.parse(String(r.tools_json ?? '[]')),
      paramsJson: String(r.params_json ?? 'null'),
      rawRequestJson,
    },
    response: {
      message: output,
      stopReason: (r.stop_reason as string | null) ?? null,
      usage: {
        input: uv(r.input_tokens, r.input_tokens_source),
        output: uv(r.output_tokens, r.output_tokens_source),
        cacheRead: uv(r.cache_read_tokens, r.cache_read_tokens_source),
        cacheWrite: uv(r.cache_write_tokens, r.cache_write_tokens_source),
      },
    },
    timeline: {
      sentAt: summary.ts,
      firstTokenAt: ttft != null ? summary.ts + ttft : null,
      finishedAt: summary.latencyMs != null ? summary.ts + summary.latencyMs : null,
    },
    redaction: {
      hits: JSON.parse(String(r.redaction_hits_json ?? '[]')),
      flagged: summary.redactionFlagged,
    },
    frameStats:
      r.frames == null
        ? null
        : {
            frames: Number(r.frames),
            bytes: Number(r.frame_bytes ?? 0),
            parseErrors: Number(r.frame_parse_errors ?? 0),
          },
  };
}

const SESSION_SELECT = `
  SELECT s.session_id, s.started_at, s.last_activity_at, s.client_name, s.workspace,
         s.session_id_source, s.client_session_id, s.title, s.cwd, s.git_branch,
         COUNT(r.request_id) AS requests,
         SUM(CASE WHEN r.status = 'upstream_error' THEN 1 ELSE 0 END) AS errors,
         GROUP_CONCAT(DISTINCT r.model) AS models,
         SUM(r.input_tokens) AS in_sum, GROUP_CONCAT(DISTINCT r.input_tokens_source) AS in_src,
         SUM(r.output_tokens) AS out_sum, GROUP_CONCAT(DISTINCT r.output_tokens_source) AS out_src,
         SUM(COALESCE(r.latency_ms, 0)) AS total_latency
  FROM sessions s LEFT JOIN requests r ON r.session_id = s.session_id`;

function rowToSession(r: Row): SessionSummary {
  // Anything not explicitly 'client-declared' is a guess, including a NULL from
  // a row written before the column existed. The weaker claim is the safe one.
  const source = r.session_id_source === 'client-declared' ? 'client-declared' : 'inferred';
  return {
    sessionId: String(r.session_id),
    startedAt: Number(r.started_at),
    lastActivityAt: Number(r.last_activity_at),
    sessionIdSource: source,
    clientSessionId: (r.client_session_id as string | null) ?? null,
    inferred: source === 'inferred',
    clientName: (r.client_name as string | null) ?? null,
    workspace: (r.workspace as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    cwd: (r.cwd as string | null) ?? null,
    gitBranch: (r.git_branch as string | null) ?? null,
    requests: Number(r.requests ?? 0),
    errors: Number(r.errors ?? 0),
    models: typeof r.models === 'string' && r.models.length ? r.models.split(',') : [],
    inputTokens: aggFrom(r.in_sum, r.in_src),
    outputTokens: aggFrom(r.out_sum, r.out_src),
    totalLatencyMs: Number(r.total_latency ?? 0),
  };
}

export function listSessions(db: Driver, limit: number, cursor?: string): SessionList {
  // Two-step on purpose: pick the PAGE of sessions off the activity index
  // first, then aggregate only those. A single GROUP BY over the join
  // aggregates every session in the database before LIMIT applies — measured
  // pathological on the year-sized bench corpus.
  const params: Array<string | number> = [];
  let where = '';
  if (cursor) {
    const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
    where = 'WHERE (last_activity_at < ? OR (last_activity_at = ? AND session_id < ?))';
    params.push(Number(ts), Number(ts), id ?? '');
  }
  const pageIds = db
    .prepare<{ session_id: string }>(
      `SELECT session_id FROM sessions ${where}
       ORDER BY last_activity_at DESC, session_id DESC LIMIT ?`,
    )
    .all(...params, limit + 1)
    .map((r) => r.session_id);

  const page = pageIds.slice(0, limit);
  if (page.length === 0) return { items: [], nextCursor: null };

  const placeholders = page.map(() => '?').join(',');
  const rows = db
    .prepare<Row>(
      `${SESSION_SELECT} WHERE s.session_id IN (${placeholders}) GROUP BY s.session_id
       ORDER BY s.last_activity_at DESC, s.session_id DESC`,
    )
    .all(...page);

  const last = rows.at(-1);
  return {
    items: rows.map(rowToSession),
    nextCursor:
      pageIds.length > limit && last
        ? Buffer.from(`${last.last_activity_at}|${last.session_id}`, 'utf-8').toString('base64url')
        : null,
  };
}

export function getSession(db: Driver, sessionId: string): SessionSummary | null {
  const r = db
    .prepare<Row>(`${SESSION_SELECT} WHERE s.session_id = ? GROUP BY s.session_id`)
    .get(sessionId);
  return r ? rowToSession(r) : null;
}

/** FTS query: user tokens become quoted terms — no FTS syntax injection. */
function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => `"${t.replaceAll('"', '')}"`)
    .join(' ');
}

export function searchMessages(db: Driver, q: string, limit: number): SearchResult {
  const t0 = performance.now();
  const query = ftsQuery(q);
  if (!query) return { items: [], totalMs: 0 };
  // Candidate cap BEFORE the join: message rowids are insert-ordered, so
  // `ORDER BY rowid DESC LIMIT 400` inside FTS yields the newest matches
  // without materializing the full match set. A broad term on a year-sized
  // corpus matches hundreds of thousands of docs; joining and sorting all of
  // them blew the 100ms budget by orders of magnitude on the bench.
  const rows = db
    .prepare<Row>(
      `SELECT c.rowid AS message_id, m.body, m.compressed, m.role,
              rm.request_id, r.session_id, r.ts
       FROM (
         SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
         ORDER BY rowid DESC LIMIT 400
       ) c
       JOIN messages m ON m.id = c.rowid
       JOIN request_messages rm ON rm.message_id = c.rowid
       JOIN requests r ON r.request_id = rm.request_id
       GROUP BY c.rowid
       ORDER BY r.ts DESC LIMIT ?`,
    )
    .all(query, limit);

  const firstTerm = q.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? '';
  const items = rows.map((r) => {
    const canonical = JSON.parse(decodeBody(r.body as Uint8Array, r.compressed === 1)) as {
      blocks: Array<{ type: string; text?: string; thinking?: string }>;
    };
    const text = canonical.blocks.map((b) => b.text ?? b.thinking ?? '').join('\n');
    const at = firstTerm ? text.toLowerCase().indexOf(firstTerm) : -1;
    const start = Math.max(0, at - 80);
    const snippet =
      (start > 0 ? '…' : '') +
      text.slice(start, Math.min(text.length, (at === -1 ? 0 : at) + 160)) +
      ((at === -1 ? 160 : at + 160) < text.length ? '…' : '');
    return {
      messageId: Number(r.message_id),
      requestId: String(r.request_id),
      sessionId: String(r.session_id),
      ts: Number(r.ts),
      role: String(r.role),
      snippet,
    };
  });
  return { items, totalMs: performance.now() - t0 };
}

export function getOverview(db: Driver, now: number): Overview {
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const t = db
    .prepare<Row>(
      `SELECT COUNT(*) AS n,
              SUM(input_tokens) AS in_sum, GROUP_CONCAT(DISTINCT input_tokens_source) AS in_src,
              SUM(output_tokens) AS out_sum, GROUP_CONCAT(DISTINCT output_tokens_source) AS out_src,
              SUM(CASE WHEN status = 'upstream_error' THEN 1 ELSE 0 END) AS errs,
              SUM(cache_read_tokens) AS cr_sum,
              COUNT(cache_read_tokens) AS cr_n
       FROM requests WHERE ts >= ?`,
    )
    .get(dayStart);

  const lats = db
    .prepare<{ l: number }>(
      'SELECT latency_ms AS l FROM requests WHERE ts >= ? AND latency_ms IS NOT NULL ORDER BY l',
    )
    .all(dayStart)
    .map((x) => x.l);

  const active = db
    .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE status IS NULL')
    .get();
  const activeSessions = db
    .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE last_activity_at >= ?')
    .get(now - 5 * 60_000);

  const hour = 3_600_000;
  const dayAgo = now - 24 * hour;
  const spark = db
    .prepare<{ t: number; n: number; out: number | null }>(
      `SELECT (ts / ${hour}) * ${hour} AS t, COUNT(*) AS n, SUM(output_tokens) AS out
       FROM requests WHERE ts >= ? GROUP BY t ORDER BY t`,
    )
    .all(dayAgo);

  // The unary + disqualifies idx_requests_model: without it the planner
  // walks every model entry in the database instead of today's ts range
  // (measured 331ms vs 2ms on the year corpus).
  const topModels = db
    .prepare<Row>(
      `SELECT model, COUNT(*) AS n, SUM(output_tokens) AS out_sum,
              GROUP_CONCAT(DISTINCT output_tokens_source) AS out_src
       FROM requests WHERE ts >= ? AND +model IS NOT NULL
       GROUP BY model ORDER BY n DESC LIMIT 5`,
    )
    .all(dayStart);

  const recentErrors = db
    .prepare<Row>(
      `SELECT request_id, ts, model, COALESCE(error_message, 'upstream error') AS msg
       FROM requests WHERE status = 'upstream_error' ORDER BY ts DESC LIMIT 5`,
    )
    .all();

  const requestsToday = Number(t?.n ?? 0);
  const errors = Number(t?.errs ?? 0);
  const cacheReadObserved = Number(t?.cr_n ?? 0) > 0;
  const inAgg = aggFrom(t?.in_sum, t?.in_src);

  return {
    activeRequests: Number(active?.n ?? 0),
    activeSessions: Number(activeSessions?.n ?? 0),
    requestsToday,
    tokensToday: { input: inAgg, output: aggFrom(t?.out_sum, t?.out_src) },
    avgLatencyMs: lats.length ? lats.reduce((a, v) => a + v, 0) / lats.length : null,
    p95LatencyMs: percentile(lats, 0.95),
    errorRateToday: requestsToday > 0 ? errors / requestsToday : null,
    // Null unless the adapter family in play actually produces cache fields —
    // on the kiro upstream nothing does, and n/a is the honest render.
    cacheHitRatio:
      cacheReadObserved && inAgg.value + Number(t?.cr_sum ?? 0) > 0
        ? Number(t?.cr_sum ?? 0) / (Number(t?.cr_sum ?? 0) + inAgg.value)
        : null,
    // No price table applies in P1 (kiro is a subscription — per-token cost
    // math against it is fiction). Never invented.
    costToday: null,
    requestsSparkline: spark.map((s) => ({ t: s.t, v: s.n })),
    outputTokensSparkline: spark.map((s) => ({ t: s.t, v: s.out ?? 0 })),
    topModels: topModels.map((m) => ({
      model: String(m.model),
      requests: Number(m.n),
      outputTokens: aggFrom(m.out_sum, m.out_src),
    })),
    recentErrors: recentErrors.map((e) => ({
      requestId: String(e.request_id),
      ts: Number(e.ts),
      model: (e.model as string | null) ?? null,
      message: String(e.msg),
    })),
  };
}

export function getStorageInfo(
  db: Driver,
  dbPath: string,
  retention: { hotDays: number; warmDays: number; coldDays: number },
): StorageInfo {
  const pageCount = Number(db.pragma('page_count') ?? 0);
  const pageSize = Number(db.pragma('page_size') ?? 0);
  const walPath = `${dbPath}-wal`;
  const walSizeBytes = existsSync(walPath) ? statSync(walPath).size : 0;

  // Counts scan primary keys (~10ms/M rows); byte totals come from running
  // meta counters — SUM over the messages table measured 586ms at year scale.
  const counts = db
    .prepare<Row>(
      `SELECT (SELECT COUNT(*) FROM requests) AS reqs,
              (SELECT COUNT(*) FROM messages) AS msgs,
              (SELECT COUNT(*) FROM sessions) AS sess`,
    )
    .get();
  const meta = (k: string): string | null =>
    (db.prepare<{ v: string }>('SELECT v FROM meta WHERE k = ?').get(k)?.v as string) ?? null;

  const tiers = db
    .prepare<{ tier: string; n: number }>('SELECT tier, COUNT(*) AS n FROM requests GROUP BY tier')
    .all();

  // request_bytes lives on the request row — no walk through the links
  // table. Bounded to the last 7 days: grouping even 30 days of a year-scale
  // corpus measured 250ms against the 200ms budget. The UI states the window.
  const largest = db
    .prepare<Row>(
      `SELECT session_id AS sid, SUM(request_bytes) AS bytes, COUNT(*) AS reqs
       FROM requests WHERE ts >= ?
       GROUP BY session_id ORDER BY bytes DESC LIMIT 5`,
    )
    .all(Date.now() - 7 * 86_400_000);

  return {
    dbSizeBytes: pageCount * pageSize,
    walSizeBytes,
    requestCount: Number(counts?.reqs ?? 0),
    messageCount: Number(counts?.msgs ?? 0),
    sessionCount: Number(counts?.sess ?? 0),
    dedupSavedBytes: Number(meta('dedup_saved_bytes') ?? 0),
    compression: {
      rawBytes: Math.max(0, Number(meta('msg_raw_bytes_total') ?? 0)),
      storedBytes: Math.max(0, Number(meta('msg_stored_bytes_total') ?? 0)),
    },
    tiers: (['hot', 'warm', 'cold', 'archive'] as const).map((tier) => ({
      tier,
      requests: tiers.find((t) => t.tier === tier)?.n ?? 0,
    })),
    largestSessions: largest.map((l) => ({
      sessionId: String(l.sid),
      bytes: Number(l.bytes ?? 0),
      requests: Number(l.reqs ?? 0),
    })),
    retention: {
      hotDays: retention.hotDays,
      warmDays: retention.warmDays,
      coldDays: retention.coldDays,
      lastCleanupAt: meta('last_cleanup_at') ? Number(meta('last_cleanup_at')) : null,
      lastVacuumAt: meta('last_vacuum_at') ? Number(meta('last_vacuum_at')) : null,
    },
  };
}
