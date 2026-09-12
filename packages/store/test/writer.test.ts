import { describe, expect, test } from 'bun:test';
import type { NormalizedMessage, RequestStarted, ResponseFinished } from '@saga/contracts';
import { decodeBody } from '../src/codec';
import { openDatabase } from '../src/driver';
import { runMigrations } from '../src/migrate';
import { MIGRATIONS } from '../src/migrations';
import { StoreWriter } from '../src/writer';

function msg(text: string, role: NormalizedMessage['role'] = 'user'): NormalizedMessage {
  return {
    role,
    blocks: [{ type: 'text', text }],
    contextSource: role === 'system' ? 'system' : role,
    contextSourceInferred: false,
  };
}

function started(requestId: string, ts: number, msgs: NormalizedMessage[]): RequestStarted {
  return {
    kind: 'request_started',
    requestId,
    ts,
    sessionId: 'ses_1',
    sessionIdSource: 'inferred',
    clientSessionId: null,
    adapterId: 'anthropic',
    provider: 'anthropic-messages',
    endpoint: '/v1/messages',
    method: 'POST',
    upstreamUrl: 'http://127.0.0.1:8000',
    clientName: 'test-client',
    workspace: '/w',
    model: 'claude-sonnet-4',
    stream: true,
    request: {
      model: 'claude-sonnet-4',
      stream: true,
      system: [msg('you are helpful', 'system')],
      messages: msgs,
      tools: [],
      paramsJson: '{"max_tokens":512}',
      rawRequestJson: JSON.stringify({ model: 'claude-sonnet-4', messages: msgs.length }),
    },
    redaction: { hits: [], flagged: false },
    // WS-C hierarchy fields — see the note in retention.test.ts on why these are
    // explicit rather than relying on the schema defaults.
    door: 'A',
    harness: 'claude-code',
    routingTier: null,
    turn: null,
    callRole: null,
    harnessIdentity: null,
    injections: [],
  };
}

function finished(
  requestId: string,
  ts: number,
  message: NormalizedMessage | null,
): ResponseFinished {
  return {
    kind: 'response_finished',
    requestId,
    ts,
    status: 'ok',
    httpStatus: 200,
    latencyMs: 800,
    ttftMs: 150,
    usage: {
      input: { value: 100, source: 'gateway-computed' },
      output: { value: 42, source: 'gateway-computed' },
      cacheRead: null,
      cacheWrite: null,
    },
    stopReason: 'end_turn',
    message,
    error: null,
    frameStats: { frames: 5, bytes: 1000, parseErrors: 0 },
    redaction: { hits: [], flagged: false },
  };
}

function freshStore() {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS);
  return { db, writer: new StoreWriter(db) };
}

describe('StoreWriter', () => {
  test('request lifecycle persists rows with provenance columns', () => {
    const { db, writer } = freshStore();
    writer.handleEvent(started('req_a', 1000, [msg('hello world')]));
    writer.handleEvent({ kind: 'first_token', requestId: 'req_a', ts: 1150, ttftMs: 150 });
    writer.handleEvent(finished('req_a', 1800, msg('hi there', 'assistant')));

    const row = db
      .prepare<Record<string, unknown>>('SELECT * FROM requests WHERE request_id = ?')
      .get('req_a');
    expect(row?.status).toBe('ok');
    expect(row?.latency_ms).toBe(800);
    expect(row?.ttft_ms).toBe(150);
    expect(row?.input_tokens).toBe(100);
    expect(row?.input_tokens_source).toBe('gateway-computed');
    expect(row?.cache_read_tokens).toBeNull();
    expect(row?.cache_read_tokens_source).toBeNull();
    expect(writer.writeErrors).toBe(0);

    const links = db
      .prepare<{ segment: string }>(
        'SELECT segment FROM request_messages WHERE request_id = ? ORDER BY seq',
      )
      .all('req_a');
    expect(links.map((l) => l.segment)).toEqual(['system', 'input', 'output']);
  });

  test('identical messages dedup to one row; refs and saved-bytes accounted', () => {
    const { db, writer } = freshStore();
    const shared = msg('same system prompt everywhere', 'system');
    writer.handleEvent({
      ...started('req_1', 1000, [msg('turn one')]),
      request: {
        ...started('req_1', 1000, []).request,
        system: [shared],
        messages: [msg('turn one')],
      },
    });
    writer.handleEvent({
      ...started('req_2', 2000, [msg('turn two')]),
      request: {
        ...started('req_2', 2000, []).request,
        system: [shared],
        messages: [msg('turn two')],
      },
    });

    const n = db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages WHERE kind = 'message' AND role = 'system'`,
      )
      .get();
    expect(n?.n).toBe(1);
    const refs = db
      .prepare<{ refs: number }>(
        `SELECT refs FROM messages WHERE role = 'system' AND kind = 'message'`,
      )
      .get();
    expect(refs?.refs).toBe(2);
    const saved = db.prepare<{ v: string }>(`SELECT v FROM meta WHERE k = 'dedup_hits'`).get();
    expect(Number(saved?.v)).toBeGreaterThanOrEqual(1);
  });

  test('large bodies are compressed and decode back verbatim', () => {
    const { db, writer } = freshStore();
    const big = 'The capture path must never block. '.repeat(200);
    writer.handleEvent(started('req_big', 1000, [msg(big)]));
    const row = db
      .prepare<{ body: Uint8Array; compressed: number; raw_bytes: number; stored_bytes: number }>(
        `SELECT m.body, m.compressed, m.raw_bytes, m.stored_bytes
         FROM messages m JOIN request_messages rm ON rm.message_id = m.id
         WHERE rm.request_id = 'req_big' AND rm.segment = 'input'`,
      )
      .get();
    expect(row?.compressed).toBe(1);
    expect(row!.stored_bytes).toBeLessThan(row!.raw_bytes);
    const decoded = JSON.parse(decodeBody(row!.body, true)) as { blocks: Array<{ text: string }> };
    expect(decoded.blocks[0]?.text).toBe(big);
  });

  test('FTS finds message text and maps back to the request', () => {
    const { db, writer } = freshStore();
    writer.handleEvent(started('req_fts', 1000, [msg('the sqlite vacuum policy is subtle')]));
    const hit = db
      .prepare<{ request_id: string }>(
        `SELECT rm.request_id AS request_id
         FROM messages_fts f JOIN request_messages rm ON rm.message_id = f.rowid
         WHERE messages_fts MATCH 'vacuum' LIMIT 5`,
      )
      .get();
    expect(hit?.request_id).toBe('req_fts');
  });

  test('tool_use then tool_result in a later request closes the loop', () => {
    const { db, writer } = freshStore();
    writer.handleEvent(started('req_t1', 1000, [msg('list files')]));
    writer.handleEvent({
      kind: 'tool_use_observed',
      requestId: 'req_t1',
      ts: 1500,
      blockIndex: 0,
      toolUseId: 'toolu_01',
      name: 'Bash',
      inputJson: '{"cmd":"ls"}',
    });
    writer.handleEvent(finished('req_t1', 1900, null));

    const carrier = started('req_t2', 3000, [
      {
        role: 'user',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_01',
            isError: false,
            content: [{ type: 'text', text: 'file-a file-b' }],
          },
        ],
        contextSource: 'tool',
        contextSourceInferred: false,
      },
    ]);
    writer.handleEvent(carrier);

    const t = db
      .prepare<Record<string, unknown>>(`SELECT * FROM tool_uses WHERE tool_use_id = 'toolu_01'`)
      .get();
    expect(t?.result_observed).toBe(1);
    expect(t?.result_is_error).toBe(0);
    expect(t?.result_request_id).toBe('req_t2');
    // emitter finished at 1000 + 800 = 1800; carrier at 3000 → 1200ms
    expect(t?.round_trip_ms).toBe(1200);
  });

  test('a malformed event is swallowed, counted, and does not throw', () => {
    const { writer } = freshStore();
    const bad = started('req_bad', 1000, [msg('x')]);
    // sabotage: session id null violates NOT NULL
    (bad as { sessionId: string | null }).sessionId = null;
    expect(() => writer.handleEvent(bad)).not.toThrow();
    expect(writer.writeErrors).toBe(1);
  });

  test('reconcileInFlight marks orphans capture_incomplete', () => {
    const { db, writer } = freshStore();
    writer.handleEvent(started('req_orphan', 1000, [msg('x')]));
    expect(writer.reconcileInFlight()).toBe(1);
    const s = db
      .prepare<{ status: string }>(`SELECT status FROM requests WHERE request_id = 'req_orphan'`)
      .get();
    expect(s?.status).toBe('capture_incomplete');
  });
});
