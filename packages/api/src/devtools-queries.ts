import type { AgentSummary, Provenance, ToolCallRow } from '@saga/contracts';
import type { Driver } from '@saga/store';

type Row = Record<string, unknown>;

function aggFrom(sum: unknown, srcCsv: unknown) {
  return {
    value: typeof sum === 'number' ? Math.max(0, Math.floor(sum)) : 0,
    sources:
      typeof srcCsv === 'string' && srcCsv.length
        ? ([...new Set(srcCsv.split(','))] as Provenance[])
        : [],
  };
}

/** Agents (P3). Correlation is heuristic; every row is inferred by type. */
export function listAgents(db: Driver, sessionId?: string): AgentSummary[] {
  const where = sessionId
    ? 'WHERE a.session_id = ?'
    : `WHERE a.last_seen_at >= ${Date.now() - 7 * 86_400_000}`;
  const params = sessionId ? [sessionId] : [];
  const rows = db
    .prepare<Row>(
      `SELECT a.agent_id, a.session_id, a.parent_agent_id, a.label, a.first_seen_at, a.last_seen_at,
              COUNT(r.request_id) AS reqs,
              SUM(r.output_tokens) AS out_sum,
              GROUP_CONCAT(DISTINCT r.output_tokens_source) AS out_src,
              SUM(r.tool_use_count) AS tools
       FROM agents a LEFT JOIN requests r ON r.agent_id = a.agent_id
       ${where}
       GROUP BY a.agent_id
       ORDER BY a.first_seen_at ASC
       LIMIT 500`,
    )
    .all(...params);
  return rows.map((r) => ({
    agentId: String(r.agent_id),
    sessionId: String(r.session_id),
    parentAgentId: (r.parent_agent_id as string | null) ?? null,
    inferred: true,
    label: String(r.label),
    firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at),
    requests: Number(r.reqs ?? 0),
    outputTokens: aggFrom(r.out_sum, r.out_src),
    toolUseCount: Number(r.tools ?? 0),
  }));
}

export function listToolStats(db: Driver): Array<{
  name: string;
  calls: number;
  errors: number | null;
  requestsUsedIn: number;
}> {
  const rows = db
    .prepare<Row>(
      `SELECT name, COUNT(*) AS calls,
              SUM(result_observed) AS observed,
              SUM(CASE WHEN result_is_error = 1 THEN 1 ELSE 0 END) AS errors,
              COUNT(DISTINCT request_id) AS reqs
       FROM tool_uses GROUP BY name ORDER BY calls DESC LIMIT 200`,
    )
    .all();
  return rows.map((r) => ({
    name: String(r.name),
    calls: Number(r.calls ?? 0),
    // errors are only knowable where a result was observed at all
    errors: Number(r.observed ?? 0) > 0 ? Number(r.errors ?? 0) : null,
    requestsUsedIn: Number(r.reqs ?? 0),
  }));
}

export function listToolCalls(
  db: Driver,
  opts: { name?: string; sessionId?: string; requestId?: string; limit: number },
): ToolCallRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.name) {
    where.push('t.name = ?');
    params.push(opts.name);
  }
  if (opts.sessionId) {
    where.push('r.session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.requestId) {
    where.push('t.request_id = ?');
    params.push(opts.requestId);
  }
  const rows = db
    .prepare<Row>(
      `SELECT t.request_id, t.tool_use_id, t.name, t.input_json, t.result_observed,
              t.result_is_error, t.round_trip_ms, r.session_id, r.agent_id, r.ts
       FROM tool_uses t JOIN requests r ON r.request_id = t.request_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.ts DESC, t.block_index ASC LIMIT ?`,
    )
    .all(...params, opts.limit);
  return rows.map((r) => ({
    requestId: String(r.request_id),
    sessionId: String(r.session_id),
    agentId: (r.agent_id as string | null) ?? null,
    ts: Number(r.ts),
    toolUseId: String(r.tool_use_id),
    name: String(r.name),
    inputJson: (r.input_json as string | null) ?? null,
    resultObserved: r.result_observed === 1,
    resultIsError: r.result_is_error == null ? null : r.result_is_error === 1,
    roundTripMs: (r.round_trip_ms as number | null) ?? null,
  }));
}
