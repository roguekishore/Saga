import { describe, expect, test } from 'bun:test';
import {
  blocksToText,
  ContentBlockSchema,
  NormalizedEventSchema,
  OverviewSchema,
  RequestStartedSchema,
  ResponseFinishedSchema,
  UsageValueSchema,
  WsServerMessageSchema,
} from '../src';

const validRequestStarted = {
  kind: 'request_started',
  requestId: 'req_01',
  ts: 1756900000000,
  sessionId: 'ses_01',
  adapterId: 'anthropic',
  provider: 'anthropic-messages',
  endpoint: '/v1/messages',
  method: 'POST',
  upstreamUrl: 'http://127.0.0.1:8000',
  clientName: 'claude-code',
  workspace: null,
  model: 'claude-sonnet-4',
  stream: true,
  request: {
    model: 'claude-sonnet-4',
    stream: true,
    system: [],
    messages: [
      {
        role: 'user',
        blocks: [{ type: 'text', text: 'hello' }],
        contextSource: 'user',
        contextSourceInferred: false,
      },
    ],
    tools: [],
    paramsJson: '{}',
    rawRequestJson: '{"model":"claude-sonnet-4"}',
  },
  redaction: { hits: [], flagged: false },
} as const;

describe('provenance', () => {
  test('usage values require a source', () => {
    expect(UsageValueSchema.safeParse({ value: 10 }).success).toBe(false);
    expect(UsageValueSchema.safeParse({ value: 10, source: 'made-up' }).success).toBe(false);
    expect(UsageValueSchema.safeParse({ value: 10, source: 'gateway-computed' }).success).toBe(
      true,
    );
  });

  test('negative and fractional token counts are rejected', () => {
    expect(UsageValueSchema.safeParse({ value: -1, source: 'saga-estimated' }).success).toBe(false);
    expect(UsageValueSchema.safeParse({ value: 1.5, source: 'saga-estimated' }).success).toBe(
      false,
    );
  });
});

describe('content blocks', () => {
  test('discriminates every block type', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { p: 1 }, inputJson: '{"p":1}' },
      {
        type: 'tool_result',
        toolUseId: 't1',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
      },
      { type: 'image', mediaType: 'image/png', byteSize: 100, note: 'content-not-stored' },
      { type: 'unknown', rawType: 'future_block', json: '{}' },
    ];
    for (const b of blocks) {
      expect(ContentBlockSchema.safeParse(b).success).toBe(true);
    }
  });

  test('image blocks cannot smuggle content', () => {
    const bad = { type: 'image', mediaType: 'image/png', byteSize: 3, note: 'stored' };
    expect(ContentBlockSchema.safeParse(bad).success).toBe(false);
  });

  test('blocksToText covers text, thinking, tools; skips images', () => {
    const text = blocksToText([
      { type: 'text', text: 'a' },
      { type: 'thinking', thinking: 'b', signature: null },
      { type: 'image', mediaType: null, byteSize: null, note: 'content-not-stored' },
      { type: 'tool_use', id: 'x', name: 'Bash', input: null, inputJson: '{"cmd":"ls"}' },
    ]);
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).toContain('Bash');
    expect(text).not.toContain('image');
  });
});

describe('NormalizedEvent union', () => {
  test('accepts a full request_started', () => {
    const r = RequestStartedSchema.safeParse(validRequestStarted);
    expect(r.success).toBe(true);
  });

  test('accepts response_finished with null usage slots (kiro cache fields)', () => {
    const r = ResponseFinishedSchema.safeParse({
      kind: 'response_finished',
      requestId: 'req_01',
      ts: 1756900001000,
      status: 'ok',
      httpStatus: 200,
      latencyMs: 812,
      ttftMs: 210,
      usage: {
        input: { value: 1200, source: 'gateway-computed' },
        output: { value: 350, source: 'gateway-computed' },
        cacheRead: null,
        cacheWrite: null,
      },
      stopReason: 'end_turn',
      message: {
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hi' }],
        contextSource: 'assistant',
        contextSourceInferred: false,
      },
      error: null,
      frameStats: { frames: 12, bytes: 4096, parseErrors: 0 },
      redaction: { hits: [], flagged: false },
    });
    expect(r.success).toBe(true);
  });

  test('rejects an unknown kind', () => {
    expect(
      NormalizedEventSchema.safeParse({ kind: 'token_burst', requestId: 'r', ts: 1 }).success,
    ).toBe(false);
  });

  test('ws envelope round-trips an event', () => {
    const msg = { type: 'event', event: validRequestStarted };
    const parsed = WsServerMessageSchema.safeParse(JSON.parse(JSON.stringify(msg)));
    expect(parsed.success).toBe(true);
  });
});

describe('ReadAPI', () => {
  test('overview permits honest nulls, forbids sourceless aggregates', () => {
    const ok = OverviewSchema.safeParse({
      activeRequests: 0,
      activeSessions: 0,
      requestsToday: 3,
      tokensToday: {
        input: { value: 100, sources: ['gateway-computed'] },
        output: { value: 40, sources: ['gateway-computed', 'saga-estimated'] },
      },
      avgLatencyMs: 900,
      p95LatencyMs: 1500,
      errorRateToday: 0,
      cacheHitRatio: null,
      costToday: null,
      requestsSparkline: [{ t: 1, v: 2 }],
      outputTokensSparkline: [],
      topModels: [],
      recentErrors: [],
    });
    expect(ok.success).toBe(true);

    const bad = OverviewSchema.safeParse({
      ...(ok.success ? ok.data : {}),
      tokensToday: { input: { value: 100 }, output: { value: 40, sources: [] } },
    });
    expect(bad.success).toBe(false);
  });
});
