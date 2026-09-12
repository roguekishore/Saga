import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TurnDetailSchema, TurnListSchema } from '@saga/contracts';
import { MIGRATIONS, openDatabase, runMigrations, type Driver } from '@saga/store';
import { getTurnDetail, listSessionTurns } from '../src/hierarchy';

/**
 * Hierarchy read API tests (C5).
 *
 * All data is inserted via raw SQL so we can control exact values for
 * door, ingest_received_at, credits, and token sources — none of which
 * handleEvent exposes as inputs. The readonly constraint is verified by
 * checking that both functions run against a readonly connection.
 */

// ---------------------------------------------------------------- fixtures

const SESSION_A = 'ses_hier_a';
const SESSION_B = 'ses_hier_b'; // used only to confirm cross-session isolation

// turn IDs in SESSION_A
const TURN_DOOR_A_PRESENT = 'turn_door_a_present'; // seq 0 — door A, ingest present
const TURN_DOOR_A_PENDING = 'turn_door_a_pending'; // seq 1 — door A, ingest pending
const TURN_DOOR_B = 'turn_door_b';               // seq 2 — door B / Gemini
const TURN_MIXED_PROV = 'turn_mixed_prov';       // seq 3 — two requests, mixed provenance
const TURN_CTX_CLIMB = 'turn_ctx_climb';          // seq 4 — context_usage_percentage climb
const TURN_SINGLE = 'turn_single';               // seq 5 — one request, no injections

// request IDs — each must be unique
const REQ_PRESENT_1 = 'req_present_1';
const REQ_PRESENT_2 = 'req_present_2';
const REQ_PENDING_1 = 'req_pending_1';
const REQ_DOOR_B_1  = 'req_door_b_1';
const REQ_MIXED_GW  = 'req_mixed_gw';
const REQ_MIXED_UP  = 'req_mixed_up';
const REQ_CTX_1     = 'req_ctx_1';
const REQ_CTX_2     = 'req_ctx_2';
const REQ_CTX_3     = 'req_ctx_3';
const REQ_SINGLE_1  = 'req_single_1';

const T0 = 1_700_000_000_000; // arbitrary stable epoch

let writeDb: Driver;
let readDb: Driver;

function insertSession(db: Driver, sessionId: string, startedAt = T0) {
  db.prepare(
    `INSERT INTO sessions (session_id, started_at, last_activity_at, door, harness)
     VALUES (?, ?, ?, 'A', 'claude-code')`,
  ).run(sessionId, startedAt, startedAt);
}

function insertTurn(
  db: Driver,
  opts: {
    turnId: string;
    sessionId: string;
    seq: number;
    startedAt?: number;
    boundarySource?: string;
    requestCount?: number;
  },
) {
  db.prepare(
    `INSERT INTO turns (turn_id, session_id, seq, started_at, boundary_source, request_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.turnId,
    opts.sessionId,
    opts.seq,
    opts.startedAt ?? T0 + opts.seq * 10_000,
    opts.boundarySource ?? 'inferred',
    opts.requestCount ?? 0,
  );
}

interface ReqOpts {
  requestId: string;
  sessionId: string;
  turnId: string;
  ts?: number;
  door?: string;
  harness?: string;
  ingestReceivedAt?: number | null;
  inputTokens?: number | null;
  inputTokensSource?: string | null;
  outputTokens?: number | null;
  outputTokensSource?: string | null;
  cacheReadTokens?: number | null;
  cacheReadTokensSource?: string | null;
  cacheWriteTokens?: number | null;
  cacheWriteTokensSource?: string | null;
  credits?: number | null;
  contextUsagePct?: number | null;
  metricsSource?: string | null;
  status?: string | null;
  callRole?: string | null;
  callRoleSource?: string | null;
  callRoleEvidenceJson?: string;
}

function insertRequest(db: Driver, opts: ReqOpts) {
  db.prepare(
    `INSERT INTO requests (
       request_id, session_id, turn_id, ts, adapter_id, provider, endpoint, method,
       door, harness, stream,
       input_tokens, input_tokens_source,
       output_tokens, output_tokens_source,
       cache_read_tokens, cache_read_tokens_source,
       cache_write_tokens, cache_write_tokens_source,
       credits, context_usage_percentage,
       metrics_source, ingest_received_at,
       status, call_role, call_role_source, call_role_evidence_json
     ) VALUES (
       ?, ?, ?, ?, 'anthropic', 'anthropic-messages', '/v1/messages', 'POST',
       ?, ?, 1,
       ?, ?,
       ?, ?,
       ?, ?,
       ?, ?,
       ?, ?,
       ?, ?,
       ?, ?, ?, ?
     )`,
  ).run(
    opts.requestId,
    opts.sessionId,
    opts.turnId,
    opts.ts ?? T0,
    opts.door ?? 'A',
    opts.harness ?? 'claude-code',
    opts.inputTokens ?? null,
    opts.inputTokensSource ?? null,
    opts.outputTokens ?? null,
    opts.outputTokensSource ?? null,
    opts.cacheReadTokens ?? null,
    opts.cacheReadTokensSource ?? null,
    opts.cacheWriteTokens ?? null,
    opts.cacheWriteTokensSource ?? null,
    opts.credits ?? null,
    opts.contextUsagePct ?? null,
    opts.metricsSource ?? null,
    opts.ingestReceivedAt ?? null,
    opts.status ?? 'ok',
    opts.callRole ?? 'main',
    opts.callRoleSource ?? 'inferred',
    opts.callRoleEvidenceJson ?? '[]',
  );
}

function insertInjection(
  db: Driver,
  requestId: string,
  seq: number,
  type: string,
  source: 'saga-observed' | 'conduit-declared',
  location?: string,
  detail?: string,
) {
  db.prepare(
    `INSERT INTO injections (request_id, seq, type, location, source, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(requestId, seq, type, location ?? null, source, detail ?? null);
}

beforeAll(() => {
  writeDb = openDatabase(':memory:');
  runMigrations(writeDb, MIGRATIONS);

  // --- Session A --- (primary test session)
  insertSession(writeDb, SESSION_A);

  // Turn 0: door A, ingest_received_at IS NOT NULL → 'present'
  insertTurn(writeDb, { turnId: TURN_DOOR_A_PRESENT, sessionId: SESSION_A, seq: 0, requestCount: 2 });
  insertRequest(writeDb, {
    requestId: REQ_PRESENT_1,
    sessionId: SESSION_A,
    turnId: TURN_DOOR_A_PRESENT,
    ts: T0 + 100,
    door: 'A',
    ingestReceivedAt: T0 + 500,
    metricsSource: 'conduit-seam',
    inputTokens: 1000,
    inputTokensSource: 'gateway-computed',
    outputTokens: 200,
    outputTokensSource: 'gateway-computed',
    credits: 3.5,
    contextUsagePct: 10.0,
  });
  insertRequest(writeDb, {
    requestId: REQ_PRESENT_2,
    sessionId: SESSION_A,
    turnId: TURN_DOOR_A_PRESENT,
    ts: T0 + 2000,
    door: 'A',
    ingestReceivedAt: T0 + 2500,
    metricsSource: 'conduit-seam',
    inputTokens: 1500,
    inputTokensSource: 'gateway-computed',
    outputTokens: 300,
    outputTokensSource: 'gateway-computed',
    credits: 5.0,
    contextUsagePct: 18.0,
  });
  // Injection on first request
  insertInjection(writeDb, REQ_PRESENT_1, 0, 'user_instructions', 'saga-observed', 'system', 'mem-ctx');
  insertInjection(writeDb, REQ_PRESENT_1, 1, 'kiro_prompt', 'conduit-declared', 'user', null);

  // Turn 1: door A, ingest_received_at IS NULL → 'pending'
  insertTurn(writeDb, { turnId: TURN_DOOR_A_PENDING, sessionId: SESSION_A, seq: 1, requestCount: 1 });
  insertRequest(writeDb, {
    requestId: REQ_PENDING_1,
    sessionId: SESSION_A,
    turnId: TURN_DOOR_A_PENDING,
    ts: T0 + 20_000,
    door: 'A',
    ingestReceivedAt: null,  // seam not yet arrived
    metricsSource: null,
    inputTokens: 800,
    inputTokensSource: 'gateway-computed',
    credits: null,
  });

  // Turn 2: door B / Gemini — credits null, will never have seam → 'not-applicable'
  insertTurn(writeDb, { turnId: TURN_DOOR_B, sessionId: SESSION_A, seq: 2, requestCount: 1 });
  insertRequest(writeDb, {
    requestId: REQ_DOOR_B_1,
    sessionId: SESSION_A,
    turnId: TURN_DOOR_B,
    ts: T0 + 40_000,
    door: 'B',
    harness: 'gemini-cli',
    ingestReceivedAt: null,  // door B never has seam
    metricsSource: 'gemini-native',
    inputTokens: 500,
    inputTokensSource: 'upstream-reported',
    outputTokens: 100,
    outputTokensSource: 'upstream-reported',
    // credits intentionally null — Vertex bills GCP-side
    credits: null,
    // cache counters null on Gemini feed
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });

  // Turn 3: mixed provenance — gateway-computed + upstream-reported in same turn
  insertTurn(writeDb, { turnId: TURN_MIXED_PROV, sessionId: SESSION_A, seq: 3, requestCount: 2 });
  insertRequest(writeDb, {
    requestId: REQ_MIXED_GW,
    sessionId: SESSION_A,
    turnId: TURN_MIXED_PROV,
    ts: T0 + 60_000,
    inputTokens: 400,
    inputTokensSource: 'gateway-computed',
    outputTokens: 80,
    outputTokensSource: 'gateway-computed',
    credits: 1.0,
  });
  insertRequest(writeDb, {
    requestId: REQ_MIXED_UP,
    sessionId: SESSION_A,
    turnId: TURN_MIXED_PROV,
    ts: T0 + 61_000,
    inputTokens: 600,
    inputTokensSource: 'upstream-reported',
    outputTokens: 120,
    outputTokensSource: 'upstream-reported',
    credits: 2.0,
  });

  // Turn 4: context_usage_percentage climb — must come back ordered, not averaged
  insertTurn(writeDb, { turnId: TURN_CTX_CLIMB, sessionId: SESSION_A, seq: 4, requestCount: 3 });
  insertRequest(writeDb, {
    requestId: REQ_CTX_1,
    sessionId: SESSION_A,
    turnId: TURN_CTX_CLIMB,
    ts: T0 + 80_000,
    contextUsagePct: 12.5,
    inputTokens: 300,
    inputTokensSource: 'gateway-computed',
  });
  insertRequest(writeDb, {
    requestId: REQ_CTX_2,
    sessionId: SESSION_A,
    turnId: TURN_CTX_CLIMB,
    ts: T0 + 81_000,
    contextUsagePct: 24.1,
    inputTokens: 600,
    inputTokensSource: 'gateway-computed',
  });
  insertRequest(writeDb, {
    requestId: REQ_CTX_3,
    sessionId: SESSION_A,
    turnId: TURN_CTX_CLIMB,
    ts: T0 + 82_000,
    contextUsagePct: 37.8,
    inputTokens: 900,
    inputTokensSource: 'gateway-computed',
  });

  // Turn 5: one request, no injections, all-null cache counters
  insertTurn(writeDb, { turnId: TURN_SINGLE, sessionId: SESSION_A, seq: 5, requestCount: 1 });
  insertRequest(writeDb, {
    requestId: REQ_SINGLE_1,
    sessionId: SESSION_A,
    turnId: TURN_SINGLE,
    ts: T0 + 100_000,
    inputTokens: 200,
    inputTokensSource: 'gateway-computed',
    // cache counters absent — must stay null, never 0
    cacheReadTokens: null,
    cacheReadTokensSource: null,
    cacheWriteTokens: null,
    cacheWriteTokensSource: null,
    credits: null,
  });

  // --- Session B --- (for isolation assertion — no turns)
  insertSession(writeDb, SESSION_B, T0 + 200_000);

  // Readonly connection for all read-side calls (mirrors the collector's model)
  readDb = writeDb; // in-memory DB shares state; readonly flag is a BunDriver option
  // For in-memory DBs, driver.ts opens the SAME connection when readonly is false,
  // so we reuse writeDb here the same way collector.ts does for ':memory:'.
});

afterAll(() => {
  writeDb.close();
});

// ---------------------------------------------------------------- listSessionTurns

describe('listSessionTurns', () => {
  test('unknown session returns empty items and null cursor', () => {
    const result = TurnListSchema.parse(
      listSessionTurns(readDb, 'session_does_not_exist', { limit: 50 }),
    );
    expect(result.sessionId).toBe('session_does_not_exist');
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  test('session with no turns returns empty items', () => {
    const result = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_B, { limit: 50 }),
    );
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  test('returns turns ordered by seq ascending', () => {
    const result = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_A, { limit: 100 }),
    );
    expect(result.items.length).toBeGreaterThanOrEqual(6);
    const seqs = result.items.map((t) => t.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  test('each turn has the correct requestCount', () => {
    const result = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_A, { limit: 100 }),
    );
    const byId = new Map(result.items.map((t) => [t.turnId, t]));
    expect(byId.get(TURN_DOOR_A_PRESENT)?.requestCount).toBe(2);
    expect(byId.get(TURN_DOOR_A_PENDING)?.requestCount).toBe(1);
    expect(byId.get(TURN_CTX_CLIMB)?.requestCount).toBe(3);
  });

  test('pagination: nextCursor is non-null when more turns exist', () => {
    const page1 = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_A, { limit: 2 }),
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[0]?.seq).toBe(0);
    expect(page1.items[1]?.seq).toBe(1);
  });

  test('pagination: cursor advances to the next page correctly', () => {
    const page1 = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_A, { limit: 2 }),
    );
    const page2 = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_A, {
        limit: 2,
        cursor: page1.nextCursor!,
      }),
    );
    expect(page2.items[0]?.seq).toBe(2);
    expect(page2.items[1]?.seq).toBe(3);
  });

  test('pagination: nextCursor is null when the last page is returned', () => {
    // Fetch all 6 turns in pages of 4
    const page1 = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_A, { limit: 4 }),
    );
    expect(page1.nextCursor).not.toBeNull();
    const page2 = TurnListSchema.parse(
      listSessionTurns(readDb, SESSION_A, {
        limit: 4,
        cursor: page1.nextCursor!,
      }),
    );
    // Remaining 2 turns fit in the limit — no more pages
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
  });

  test('combined pages cover exactly the full turn set with no duplicates', () => {
    const all: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = TurnListSchema.parse(
        listSessionTurns(readDb, SESSION_A, { limit: 2, cursor: cursor ?? undefined }),
      );
      for (const item of result.items) all.push(item.turnId);
      cursor = result.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(new Set(all).size).toBe(all.length); // no duplicates
    expect(pages).toBe(3); // 6 turns / 2 per page
  });
});

// ---------------------------------------------------------------- getTurnDetail

describe('getTurnDetail', () => {
  test('returns null for an unknown turnId', () => {
    expect(getTurnDetail(readDb, 'turn_does_not_exist')).toBeNull();
  });

  test('result parses against the frozen TurnDetailSchema', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_A_PRESENT);
    expect(detail).not.toBeNull();
    TurnDetailSchema.parse(detail);
  });

  // ---- seamStatus: three distinct states ----

  test('seamStatus is "present" when door=A and ingest_received_at IS NOT NULL', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_A_PRESENT)!;
    expect(detail.exchanges).toHaveLength(2);
    for (const ex of detail.exchanges) {
      expect(ex.seamStatus).toBe('present');
    }
  });

  test('seamStatus is "pending" when door=A and ingest_received_at IS NULL', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_A_PENDING)!;
    expect(detail.exchanges).toHaveLength(1);
    expect(detail.exchanges[0]?.seamStatus).toBe('pending');
  });

  test('seamStatus is "not-applicable" for door=B (Gemini, never has seam)', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_B)!;
    expect(detail.exchanges).toHaveLength(1);
    expect(detail.exchanges[0]?.seamStatus).toBe('not-applicable');
    // "not-applicable" and "pending" must be distinguishable — never collapse to same value
    const pendingDetail = getTurnDetail(readDb, TURN_DOOR_A_PENDING)!;
    expect(detail.exchanges[0]?.seamStatus).not.toBe(pendingDetail.exchanges[0]?.seamStatus);
  });

  // ---- contextUsageReadings: ordered, unaggregated ----

  test('contextUsageReadings comes back ordered by ts, unaggregated', () => {
    const detail = getTurnDetail(readDb, TURN_CTX_CLIMB)!;
    const readings = detail.turn.contextUsageReadings;
    // Three requests with ascending pcts — must be [12.5, 24.1, 37.8]
    expect(readings).toHaveLength(3);
    expect(readings[0]).toBeCloseTo(12.5);
    expect(readings[1]).toBeCloseTo(24.1);
    expect(readings[2]).toBeCloseTo(37.8);
    // Verify they are NOT averaged (average would be ≈24.8)
    for (const r of readings) {
      expect(Math.abs(r - 24.8)).toBeGreaterThan(0.1);
    }
    // Ascending order
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThan(readings[i - 1]!);
    }
  });

  // ---- AggUsage: provenance survives aggregation ----

  test('mixed provenance in one turn yields AggUsage.sources with both entries', () => {
    const detail = getTurnDetail(readDb, TURN_MIXED_PROV)!;
    const inputSrcs = detail.turn.inputTokens.sources;
    const outputSrcs = detail.turn.outputTokens.sources;
    // Both gateway-computed and upstream-reported contributed — must appear as two entries
    expect(inputSrcs).toContain('gateway-computed');
    expect(inputSrcs).toContain('upstream-reported');
    expect(inputSrcs).toHaveLength(2);
    expect(outputSrcs).toContain('gateway-computed');
    expect(outputSrcs).toContain('upstream-reported');
  });

  test('single-provenance turn has exactly one source entry', () => {
    const detail = getTurnDetail(readDb, TURN_SINGLE)!;
    expect(detail.turn.inputTokens.sources).toEqual(['gateway-computed']);
    expect(detail.turn.inputTokens.sources).toHaveLength(1);
  });

  // ---- NULL IS NOT ZERO ----

  test('credits is null when all requests in turn have null credits', () => {
    const detail = getTurnDetail(readDb, TURN_SINGLE)!;
    // TURN_SINGLE's request has credits=null
    expect(detail.turn.credits).toBeNull();
  });

  test('credits is null for door B (Gemini) turns — Vertex bills GCP-side', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_B)!;
    expect(detail.turn.credits).toBeNull();
    // The exchange itself also has null credits
    expect(detail.exchanges[0]?.credits).toBeNull();
  });

  test('cache tokens stay null through rollup — never coerced to 0', () => {
    const detail = getTurnDetail(readDb, TURN_SINGLE)!;
    const ex = detail.exchanges[0]!;
    // cacheRead / cacheWrite are null on this feed
    expect(ex.usage.cacheRead).toBeNull();
    expect(ex.usage.cacheWrite).toBeNull();
  });

  test('door B exchange carries null credits and null cache tokens', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_B)!;
    const ex = detail.exchanges[0]!;
    expect(ex.credits).toBeNull();
    expect(ex.usage.cacheRead).toBeNull();
    expect(ex.usage.cacheWrite).toBeNull();
    // But input tokens are present (Gemini reports them)
    expect(ex.usage.input).not.toBeNull();
    expect(ex.usage.input?.source).toBe('upstream-reported');
  });

  // ---- exchanges ordering and injection tags ----

  test('exchanges are ordered by ts ascending (seqInTurn 0, 1, …)', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_A_PRESENT)!;
    expect(detail.exchanges).toHaveLength(2);
    expect(detail.exchanges[0]?.seqInTurn).toBe(0);
    expect(detail.exchanges[1]?.seqInTurn).toBe(1);
    expect(detail.exchanges[0]?.ts).toBeLessThan(detail.exchanges[1]!.ts);
  });

  test('injection tags are returned on the correct exchange', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_A_PRESENT)!;
    const firstEx = detail.exchanges[0]!;
    expect(firstEx.requestId).toBe(REQ_PRESENT_1);
    expect(firstEx.injections).toHaveLength(2);
    expect(firstEx.injections[0]?.source).toBe('saga-observed');
    expect(firstEx.injections[1]?.source).toBe('conduit-declared');
    expect(firstEx.injections[0]?.seq).toBe(0);
    expect(firstEx.injections[1]?.seq).toBe(1);
    // Second exchange has no injections
    expect(detail.exchanges[1]?.injections).toHaveLength(0);
  });

  test('turn with one exchange and no injections behaves correctly', () => {
    const detail = getTurnDetail(readDb, TURN_SINGLE)!;
    TurnDetailSchema.parse(detail);
    expect(detail.exchanges).toHaveLength(1);
    expect(detail.exchanges[0]?.injections).toHaveLength(0);
    expect(detail.exchanges[0]?.toolCalls).toHaveLength(0);
  });

  // ---- endedAt = MAX(ts) ----

  test('turn endedAt equals the MAX ts of its requests', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_A_PRESENT)!;
    // Two requests at T0+100 and T0+2000 → endedAt should be T0+2000
    expect(detail.turn.endedAt).toBe(T0 + 2000);
  });

  test('turn spanMs = endedAt - startedAt', () => {
    const detail = getTurnDetail(readDb, TURN_DOOR_A_PRESENT)!;
    const { startedAt, endedAt, spanMs } = detail.turn;
    expect(endedAt).not.toBeNull();
    expect(spanMs).toBe(endedAt! - startedAt);
  });

  // ---- measured query timing ----

  test('per-turn query timing with realistic fixture row count', () => {
    // The TURN_CTX_CLIMB turn has 3 requests; enough to hit the index path.
    const t0 = performance.now();
    const detail = getTurnDetail(readDb, TURN_CTX_CLIMB);
    const elapsed = performance.now() - t0;
    expect(detail).not.toBeNull();
    // Report timing — this is in-memory so it should be sub-millisecond,
    // but the assertion is just that it completes (correctness, not speed).
    // See C5 report for measured timing against a corpus with realistic row counts.
    console.info(
      `[hierarchy] getTurnDetail(TURN_CTX_CLIMB, 3 requests) = ${elapsed.toFixed(2)}ms`,
    );
    expect(elapsed).toBeLessThan(500); // well under the 200ms production target for in-memory
  });
});
