import { describe, expect, test } from 'bun:test';
import type { ConduitIngest, NormalizedEvent } from '@saga/contracts';
import { DEFAULT_MAX_INGEST_BYTES, handleConduitIngest } from '../src/ingest';

/**
 * Unit tests for `handleConduitIngest`.
 *
 * These tests call the handler directly — no running server needed. The key
 * invariant under test: the handler MUST NOT write to SQLite. It validates,
 * redacts, calls `opts.emit`, and returns. The structural proof is that no
 * `db`/`Driver` parameter appears in the function signature — `handleConduitIngest`
 * accepts only `(opts, rawBody, byteLength)`.
 */

// ---------------------------------------------------------------- helpers

function makePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    request_id: 'req_ingest_test_001',
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function collectEmits(): { emitted: NormalizedEvent[]; emit: (ev: NormalizedEvent) => void } {
  const emitted: NormalizedEvent[] = [];
  return { emitted, emit: (ev) => emitted.push(ev) };
}

// ---------------------------------------------------------------- tests

describe('handleConduitIngest', () => {
  // ---------------------------------------------------------------------- 1
  test('happy path: valid payload → 200, accepted:true, emit called once with correct shape', () => {
    const { emitted, emit } = collectEmits();

    const result = handleConduitIngest({ emit }, makePayload(), 512);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ accepted: true });
    expect(emitted.length).toBe(1);

    const ev = emitted[0] as ConduitIngest;
    expect(ev.kind).toBe('conduit_ingest');
    expect(ev.requestId).toBe('req_ingest_test_001');
    expect(ev.ts).toBe(1_700_000_000_000);
  });

  // ---------------------------------------------------------------------- 2
  test('body too large: byteLength > DEFAULT_MAX_INGEST_BYTES → 413, emit not called', () => {
    const { emitted, emit } = collectEmits();

    const result = handleConduitIngest({ emit }, makePayload(), DEFAULT_MAX_INGEST_BYTES + 1);

    expect(result.status).toBe(413);
    expect(emitted.length).toBe(0);
    // Body cap is stated clearly in the error
    const body = result.body as { error: string };
    expect(body.error).toContain(String(DEFAULT_MAX_INGEST_BYTES));
  });

  // ---------------------------------------------------------------------- 3
  test('invalid payload shape: bad structure → 400, error mentions invalid ingest payload, emit not called', () => {
    const { emitted, emit } = collectEmits();

    const result = handleConduitIngest(
      { emit },
      // Missing required fields (request_id is required and must be non-empty)
      { not_a_valid_payload: true },
      200,
    );

    expect(result.status).toBe(400);
    expect(emitted.length).toBe(0);
    const body = result.body as { error: string };
    expect(body.error).toContain('invalid ingest payload');
  });

  test('invalid payload shape: empty request_id → 400, emit not called', () => {
    const { emitted, emit } = collectEmits();

    const result = handleConduitIngest({ emit }, makePayload({ request_id: '' }), 200);

    expect(result.status).toBe(400);
    expect(emitted.length).toBe(0);
  });

  // ---------------------------------------------------------------------- 4
  test('rewritten_out redaction: planted secret is scrubbed; redaction.hits is non-empty', () => {
    // sk-ant-api03-… matches the `anthropic-key` pattern in @saga/redact.
    // The suffix needs 16+ chars from [A-Za-z0-9_-].
    const plantedSecret = 'sk-ant-api03-PLANTEDsecretValue01';

    const { emitted, emit } = collectEmits();

    const result = handleConduitIngest(
      { emit },
      makePayload({
        rewritten_out: {
          system_prompt: `System instructions. API key is ${plantedSecret}. Do not share.`,
          current_message: null,
          history: [],
          tools: [],
          injections: [],
        },
      }),
      2_000,
    );

    expect(result.status).toBe(200);
    expect(emitted.length).toBe(1);

    const ev = emitted[0] as ConduitIngest;
    // Secret must not appear anywhere in the serialized output
    expect(ev.rewrittenOutJson).not.toBeNull();
    expect(ev.rewrittenOutJson).not.toContain(plantedSecret);
    // At least one redaction hit must have been recorded
    expect(ev.redaction.hits.length).toBeGreaterThan(0);
    // The anthropic-key pattern is a known shape; the named hit must be present
    const kinds = ev.redaction.hits.map((h) => h.kind);
    expect(kinds).toContain('anthropic-key');
  });

  // ---------------------------------------------------------------------- 5
  test('rewritten_out null: emitted event has rewrittenOutJson null, redaction.hits empty', () => {
    const { emitted, emit } = collectEmits();

    const result = handleConduitIngest({ emit }, makePayload({ rewritten_out: null }), 200);

    expect(result.status).toBe(200);
    expect(emitted.length).toBe(1);

    const ev = emitted[0] as ConduitIngest;
    expect(ev.rewrittenOutJson).toBeNull();
    expect(ev.redaction.hits).toEqual([]);
    expect(ev.redaction.flagged).toBe(false);
  });

  // ---------------------------------------------------------------------- 6
  test('no-throw guarantee: emit that throws → 500 returned, nothing propagates', () => {
    // The handler must absorb all errors; a bug inside must cost one POST, not
    // take the ingest route down for CONDUIT.
    let threw = false;
    let result: ReturnType<typeof handleConduitIngest>;

    try {
      result = handleConduitIngest(
        {
          emit: () => {
            throw new Error('emit exploded intentionally');
          },
        },
        makePayload(),
        200,
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.status).toBe(500);
    const body = result!.body as { error: string };
    expect(typeof body.error).toBe('string');
  });

  // ---------------------------------------------------------------------- 7
  test('fire-and-forget shape: result is {status, body}; no db handle present', () => {
    // Structural invariant: handleConduitIngest takes (opts, rawBody, byteLength)
    // — no db/Driver parameter. Verified at the type level by importing the
    // function without a db argument compiling cleanly, and at runtime by
    // confirming the result carries no db handle.
    const result = handleConduitIngest({ emit: () => {} }, makePayload(), 200);

    expect(typeof result.status).toBe('number');
    expect('body' in result).toBe(true);

    // The result must NOT expose any database handle.
    expect('db' in result).toBe(false);

    // The function itself must accept exactly 3 parameters — opts, rawBody,
    // byteLength — with no db/Driver anywhere in the signature.
    expect(handleConduitIngest.length).toBe(3);
  });

  // ---------------------------------------------------------------------- 8
  test('idempotency is NOT this layer: two calls with same request_id both emit (dedup is writer job)', () => {
    // Dedup-by-request_id lives downstream in StoreWriter.onConduitIngest,
    // which is the only place with prior state to compare against. This layer
    // pushes to the queue twice; the writer is responsible for ignoring the
    // second.
    const { emitted, emit } = collectEmits();
    const payload = makePayload({ request_id: 'req_dupe_001' });

    handleConduitIngest({ emit }, payload, 200);
    handleConduitIngest({ emit }, payload, 200);

    expect(emitted.length).toBe(2);
    expect(emitted[0]?.requestId).toBe('req_dupe_001');
    expect(emitted[1]?.requestId).toBe('req_dupe_001');
  });

  // ---------------------------------------------------------------------- extra coverage
  test('maxBodyBytes option is respected: custom cap overrides the default', () => {
    const { emitted, emit } = collectEmits();

    // byteLength == custom cap: allowed
    const ok = handleConduitIngest({ emit, maxBodyBytes: 1_000 }, makePayload(), 1_000);
    expect(ok.status).toBe(200);

    emitted.length = 0;

    // byteLength > custom cap: rejected
    const rejected = handleConduitIngest({ emit, maxBodyBytes: 1_000 }, makePayload(), 1_001);
    expect(rejected.status).toBe(413);
    expect(emitted.length).toBe(0);
  });

  test('metrics and model_id fields pass through into the emitted payload', () => {
    const { emitted, emit } = collectEmits();

    const result = handleConduitIngest(
      { emit },
      makePayload({
        model_id: 'claude-opus-4-7',
        metrics: {
          input_tokens: 1000,
          output_tokens: 500,
          thought_tokens: 200,
          cache_read_tokens: null,
          cache_write_tokens: null,
          total_tokens: 1700,
          credits: 0.42,
          context_usage_percentage: 12.5,
          stop_reason: 'end_turn',
          reasoning_blocks: [],
        },
      }),
      1_000,
    );

    expect(result.status).toBe(200);
    const ev = emitted[0] as ConduitIngest;
    expect(ev.payload.model_id).toBe('claude-opus-4-7');
    expect(ev.payload.metrics?.input_tokens).toBe(1000);
    expect(ev.payload.metrics?.credits).toBe(0.42);
    expect(ev.payload.metrics?.stop_reason).toBe('end_turn');
  });
});
