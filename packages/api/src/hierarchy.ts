import type {
  AggUsage,
  Exchange,
  InjectionTag,
  Provenance,
  TurnDetail,
  TurnList,
  TurnSummary,
  UsageValue,
} from '@saga/contracts';
import { type Driver, decodeBody } from '@saga/store';

/**
 * Hierarchy read path (C5). Serves:
 *   project → conversation → human message → requests it triggered → injection tags
 *
 * Constraints honoured (all load-bearing):
 *  - READ ONLY — takes the readonly Driver; never writes.
 *  - NULL IS NOT ZERO — SUM returns null when all inputs are null; we propagate
 *    that. No COALESCE on credits or cache counters.
 *  - PROVENANCE SURVIVES AGGREGATION — AggUsage.sources carries every distinct
 *    provenance that contributed; GROUP_CONCAT(DISTINCT …_source) builds the set.
 *  - THREE seamStatus STATES — door B → 'not-applicable', door A +
 *    ingest_received_at IS NOT NULL → 'present', door A + null → 'pending'.
 *  - contextUsageReadings ORDERED AND UNAGGREGATED — GROUP_CONCAT ordered by ts
 *    so the climb is visible; never averaged.
 *  - endedAt = MAX(r.ts) of requests in the turn — last observed activity, not a
 *    declared close.
 *  - PERFORMANCE — per-turn query bounded by turn via idx_requests_turn; turn
 *    list bounded by session via idx_turns_session_seq; turn list paginated.
 */

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- helpers

function uv(value: unknown, source: unknown): UsageValue | null {
  return typeof value === 'number' && typeof source === 'string'
    ? { value, source: source as Provenance }
    : null;
}

/**
 * Build AggUsage from a SQL SUM and a GROUP_CONCAT(DISTINCT …_source) CSV.
 * When SUM is null (all contributing rows had null), value is 0 and sources
 * is empty — the contract's "nothing contributed" shape.
 */
function aggTokens(sum: unknown, srcCsv: unknown): AggUsage {
  return {
    value: typeof sum === 'number' ? Math.max(0, Math.floor(sum)) : 0,
    sources:
      typeof srcCsv === 'string' && srcCsv.length > 0
        ? ([...new Set(srcCsv.split(',').filter(Boolean))] as Provenance[])
        : [],
  };
}

/**
 * Parse the ordered GROUP_CONCAT of context_usage_percentage readings.
 * GROUP_CONCAT skips nulls, so only real readings appear. Order is ts ASC
 * (guaranteed by the aggregate ORDER BY clause).
 */
function parseCtxReadings(csv: unknown): number[] {
  if (typeof csv !== 'string' || csv.length === 0) return [];
  return csv.split(',').flatMap((s) => {
    const n = Number(s.trim());
    return Number.isNaN(n) ? [] : [n];
  });
}

function parseCallRoles(csv: unknown): TurnSummary['callRoles'] {
  if (typeof csv !== 'string' || csv.length === 0) return [];
  const valid = new Set<string>(['main', 'subagent', 'utility', 'unknown']);
  return [...new Set(csv.split(',').filter((r) => valid.has(r)))] as TurnSummary['callRoles'];
}

/** Three-state seam status. Door B will NEVER have a seam payload — do not conflate with door A pending. */
function seamStatusFor(door: unknown, ingestReceivedAt: unknown): Exchange['seamStatus'] {
  if (door === 'B') return 'not-applicable';
  return ingestReceivedAt != null ? 'present' : 'pending';
}

function safeHarness(v: unknown): Exchange['harness'] {
  const valid = new Set<string>(['claude-code', 'codex', 'gemini-cli', 'unknown']);
  return typeof v === 'string' && valid.has(v) ? (v as Exchange['harness']) : 'unknown';
}

function safeCallRole(v: unknown): Exchange['callRole'] {
  const valid = new Set<string>(['main', 'subagent', 'utility', 'unknown']);
  return typeof v === 'string' && valid.has(v) ? (v as Exchange['callRole']) : 'unknown';
}

function safeCallRoleSource(v: unknown): Exchange['callRoleSource'] {
  return v === 'harness-declared' ? 'harness-declared' : 'inferred';
}

function safeBoundarySource(v: unknown): TurnSummary['boundarySource'] {
  return v === 'harness-declared' ? 'harness-declared' : 'inferred';
}

// ---------------------------------------------------------------- SQL fragments

/**
 * Aggregate columns to JOIN onto each turns row. LEFT JOIN so turns with no
 * requests still appear (e.g. a turn opened but capture died before any request
 * arrived). Uses idx_requests_turn (turn_id, ts) so the join is bounded by turn.
 *
 * credits: SUM returns null when every row has null credits (Gemini, door B).
 * That null propagates through to the response — never coerced to 0.
 *
 * context_usage_percentage: ordered by ts so the climb is preserved in the CSV.
 */
const REQ_AGG_COLS = `
  COUNT(r.request_id)                                          AS actual_req_count,
  MAX(r.ts)                                                    AS last_req_ts,
  SUM(r.input_tokens)                                          AS in_sum,
  GROUP_CONCAT(DISTINCT r.input_tokens_source)                 AS in_src,
  SUM(r.output_tokens)                                         AS out_sum,
  GROUP_CONCAT(DISTINCT r.output_tokens_source)                AS out_src,
  SUM(r.thought_tokens)                                        AS thought_sum,
  GROUP_CONCAT(DISTINCT r.thought_tokens_source)               AS thought_src,
  SUM(r.credits)                                               AS credits_sum,
  GROUP_CONCAT(r.context_usage_percentage ORDER BY r.ts)       AS ctx_usage_csv,
  GROUP_CONCAT(DISTINCT r.call_role)                           AS call_roles_csv,
  SUM(CASE WHEN r.status = 'upstream_error' THEN 1 ELSE 0 END) AS errors
`;

const TURN_COLS = `
  t.turn_id, t.session_id, t.seq, t.started_at, t.boundary_source,
  t.harness_turn_id, t.partial, t.evidence_json, t.request_count
`;

const TURN_LIST_SQL = `
  SELECT ${TURN_COLS}, ${REQ_AGG_COLS}
  FROM turns t
  LEFT JOIN requests r ON r.turn_id = t.turn_id
  WHERE t.session_id = ?
  GROUP BY t.turn_id
  ORDER BY t.seq ASC
  LIMIT ?`;

const TURN_LIST_CURSOR_SQL = `
  SELECT ${TURN_COLS}, ${REQ_AGG_COLS}
  FROM turns t
  LEFT JOIN requests r ON r.turn_id = t.turn_id
  WHERE t.session_id = ? AND t.seq > ?
  GROUP BY t.turn_id
  ORDER BY t.seq ASC
  LIMIT ?`;

const TURN_AGG_SQL = `
  SELECT ${TURN_COLS}, ${REQ_AGG_COLS}
  FROM turns t
  LEFT JOIN requests r ON r.turn_id = t.turn_id
  WHERE t.turn_id = ?
  GROUP BY t.turn_id`;

const EXCHANGES_SQL = `
  SELECT
    r.request_id, r.ts, r.door, r.harness, r.model,
    r.call_role, r.call_role_source, r.call_role_evidence_json,
    r.routing_tier, r.status, r.latency_ms, r.ttft_ms,
    r.input_tokens, r.input_tokens_source,
    r.output_tokens, r.output_tokens_source,
    r.cache_read_tokens, r.cache_read_tokens_source,
    r.cache_write_tokens, r.cache_write_tokens_source,
    r.thought_tokens, r.thought_tokens_source,
    r.credits, r.context_usage_percentage,
    r.metrics_source, r.ingest_received_at,
    r.stop_reason,
    (ROW_NUMBER() OVER (ORDER BY r.ts, r.request_id)) - 1 AS seq_in_turn
  FROM requests r
  WHERE r.turn_id = ?
  ORDER BY r.ts ASC, r.request_id ASC`;

/** Batch-fetch output messages for all requests in a turn — avoids N+1. */
const OUTPUT_MSGS_SQL = `
  SELECT rm.request_id, m.body, m.compressed
  FROM request_messages rm
  JOIN messages m ON m.id = rm.message_id
  JOIN requests r ON r.request_id = rm.request_id
  WHERE r.turn_id = ? AND rm.segment = 'output'
  ORDER BY rm.request_id, rm.seq`;

const TOOL_CALLS_SQL = `
  SELECT tu.request_id, tu.tool_use_id, tu.name
  FROM tool_uses tu
  JOIN requests r ON r.request_id = tu.request_id
  WHERE r.turn_id = ?
  ORDER BY tu.request_id, tu.block_index`;

const INJECTIONS_SQL = `
  SELECT i.request_id, i.seq, i.type, i.location, i.source, i.detail
  FROM injections i
  JOIN requests r ON r.request_id = i.request_id
  WHERE r.turn_id = ?
  ORDER BY i.request_id, i.seq`;

// ---------------------------------------------------------------- row builders

function rowToTurnSummary(row: Row): TurnSummary {
  const lastTs = typeof row.last_req_ts === 'number' ? row.last_req_ts : null;
  const startedAt = Number(row.started_at);
  return {
    turnId: String(row.turn_id),
    sessionId: String(row.session_id),
    seq: Number(row.seq),
    startedAt,
    endedAt: lastTs,
    boundarySource: safeBoundarySource(row.boundary_source),
    harnessTurnId: (row.harness_turn_id as string | null) ?? null,
    partial: row.partial === 1,
    evidence: JSON.parse(String(row.evidence_json ?? '[]')) as string[],
    requestCount: Number(row.actual_req_count ?? 0),
    spanMs: lastTs != null ? lastTs - startedAt : null,
    inputTokens: aggTokens(row.in_sum, row.in_src),
    outputTokens: aggTokens(row.out_sum, row.out_src),
    thoughtTokens: aggTokens(row.thought_sum, row.thought_src),
    // credits: null when every request in the turn had null (Gemini/door B).
    // SUM of all-null is null in SQLite, which propagates correctly here.
    credits: typeof row.credits_sum === 'number' ? row.credits_sum : null,
    contextUsageReadings: parseCtxReadings(row.ctx_usage_csv),
    callRoles: parseCallRoles(row.call_roles_csv),
    errors: Number(row.errors ?? 0),
  };
}

/** Extract a short text preview from a decompressed message body. */
function previewFromBody(body: unknown, compressed: unknown): string | null {
  if (!(body instanceof Uint8Array)) return null;
  try {
    const json = JSON.parse(decodeBody(body, compressed === 1)) as {
      blocks?: Array<{ type: string; text?: string }>;
    };
    for (const block of json.blocks ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text.slice(0, 200);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- public API

export function listSessionTurns(
  db: Driver,
  sessionId: string,
  opts: { limit: number; cursor?: string },
): TurnList {
  const { limit, cursor } = opts;

  let rows: Row[];
  if (cursor) {
    const cursorSeq = Number(Buffer.from(cursor, 'base64url').toString('utf-8'));
    rows = db.prepare<Row>(TURN_LIST_CURSOR_SQL).all(sessionId, cursorSeq, limit + 1);
  } else {
    rows = db.prepare<Row>(TURN_LIST_SQL).all(sessionId, limit + 1);
  }

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastSeq = page.at(-1)?.seq;
  const nextCursor =
    hasMore && lastSeq != null ? Buffer.from(String(lastSeq), 'utf-8').toString('base64url') : null;

  return {
    sessionId,
    items: page.map(rowToTurnSummary),
    nextCursor,
  };
}

export function getTurnDetail(db: Driver, turnId: string): TurnDetail | null {
  const turnRow = db.prepare<Row>(TURN_AGG_SQL).get(turnId);
  if (!turnRow) return null;

  const turn = rowToTurnSummary(turnRow);

  const exchangeRows = db.prepare<Row>(EXCHANGES_SQL).all(turnId);

  // Batch-fetch supporting data keyed by request_id — avoids N+1 per exchange.
  const outputMsgRows = db.prepare<Row>(OUTPUT_MSGS_SQL).all(turnId);
  const toolCallRows = db.prepare<Row>(TOOL_CALLS_SQL).all(turnId);
  const injectionRows = db.prepare<Row>(INJECTIONS_SQL).all(turnId);

  // Index by request_id
  const replyPreviews = new Map<string, string | null>();
  for (const r of outputMsgRows) {
    const rid = String(r.request_id);
    if (!replyPreviews.has(rid)) {
      replyPreviews.set(rid, previewFromBody(r.body, r.compressed));
    }
  }

  const toolCallsByReq = new Map<string, Array<{ toolUseId: string; name: string }>>();
  for (const r of toolCallRows) {
    const rid = String(r.request_id);
    const list = toolCallsByReq.get(rid) ?? [];
    list.push({ toolUseId: String(r.tool_use_id), name: String(r.name) });
    toolCallsByReq.set(rid, list);
  }

  const injectionsByReq = new Map<string, InjectionTag[]>();
  for (const r of injectionRows) {
    const rid = String(r.request_id);
    const list = injectionsByReq.get(rid) ?? [];
    list.push({
      seq: Number(r.seq),
      type: String(r.type),
      location: (r.location as string | null) ?? null,
      source: r.source as InjectionTag['source'],
      detail: (r.detail as string | null) ?? null,
    });
    injectionsByReq.set(rid, list);
  }

  const exchanges: Exchange[] = exchangeRows.map((r) => {
    const rid = String(r.request_id);
    return {
      requestId: rid,
      ts: Number(r.ts),
      seqInTurn: Number(r.seq_in_turn),
      door: r.door === 'B' ? 'B' : 'A',
      harness: safeHarness(r.harness),
      model: (r.model as string | null) ?? null,
      callRole: safeCallRole(r.call_role),
      callRoleSource: safeCallRoleSource(r.call_role_source),
      callRoleEvidence: JSON.parse(String(r.call_role_evidence_json ?? '[]')) as string[],
      routingTier: (r.routing_tier as string | null) ?? null,
      status: (r.status as Exchange['status']) ?? null,
      latencyMs: (r.latency_ms as number | null) ?? null,
      ttftMs: (r.ttft_ms as number | null) ?? null,
      usage: {
        input: uv(r.input_tokens, r.input_tokens_source),
        output: uv(r.output_tokens, r.output_tokens_source),
        cacheRead: uv(r.cache_read_tokens, r.cache_read_tokens_source),
        cacheWrite: uv(r.cache_write_tokens, r.cache_write_tokens_source),
        thought: uv(r.thought_tokens, r.thought_tokens_source),
        total: null,
      },
      // credits: null on door B by design; propagate as-is, never coerce to 0.
      credits: (r.credits as number | null) ?? null,
      contextUsagePercentage: (r.context_usage_percentage as number | null) ?? null,
      stopReason: (r.stop_reason as string | null) ?? null,
      metricsSource: (r.metrics_source as Exchange['metricsSource']) ?? null,
      seamStatus: seamStatusFor(r.door, r.ingest_received_at),
      replyPreview: replyPreviews.get(rid) ?? null,
      toolCalls: toolCallsByReq.get(rid) ?? [],
      injections: injectionsByReq.get(rid) ?? [],
    };
  });

  return { turn, exchanges };
}
