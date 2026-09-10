import { afterAll, describe, expect, test } from 'bun:test';
import { noopLogger } from '@saga/contracts';
import { createOtelExporter } from '../src/otel';

let server: ReturnType<typeof Bun.serve> | null = null;

afterAll(() => server?.stop(true));

describe('OTel exporter', () => {
  test('finished requests become OTLP spans with provenance-tagged token attrs', async () => {
    const received: unknown[] = [];
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/traces') {
          received.push(await req.json());
          return Response.json({});
        }
        return new Response('404', { status: 404 });
      },
    });

    const otel = createOtelExporter(`http://127.0.0.1:${server.port}`, noopLogger, 60);
    otel.subscriber({
      kind: 'request_started',
      requestId: 'req_otel',
      ts: 1000,
      sessionId: 'ses_1',
      sessionIdSource: 'inferred',
      clientSessionId: null,
      adapterId: 'anthropic',
      provider: 'anthropic-messages',
      endpoint: '/v1/messages',
      method: 'POST',
      upstreamUrl: 'http://u',
      clientName: null,
      workspace: null,
      model: 'claude-sonnet-4',
      stream: true,
      request: {
        model: 'claude-sonnet-4',
        stream: true,
        system: [],
        messages: [],
        tools: [],
        paramsJson: '{}',
        rawRequestJson: '{}',
      },
      redaction: { hits: [], flagged: false },
    });
    otel.subscriber({
      kind: 'response_finished',
      requestId: 'req_otel',
      ts: 2000,
      status: 'ok',
      httpStatus: 200,
      latencyMs: 1000,
      ttftMs: 150,
      usage: {
        input: { value: 100, source: 'gateway-computed' },
        output: { value: 50, source: 'gateway-computed' },
        cacheRead: null,
        cacheWrite: null,
      },
      stopReason: 'end_turn',
      message: null,
      error: null,
      frameStats: { frames: 3, bytes: 100, parseErrors: 0 },
      redaction: { hits: [], flagged: false },
    });

    await new Promise((r) => setTimeout(r, 200));
    otel.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const batch = received[0] as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      }>;
    };
    const span = batch.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.name).toBe('claude-sonnet-4');
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    const attrs = span.attributes as Array<{ key: string }>;
    expect(attrs.some((a) => a.key === 'gen_ai.usage.output_tokens.gateway-computed')).toBe(true);
    expect(attrs.some((a) => a.key === 'saga.adapter')).toBe(true);
    // start/end reconstruct the measured window
    expect(span.startTimeUnixNano).toBe(String(1000 * 1e6));
    expect(span.endTimeUnixNano).toBe(String(2000 * 1e6));
  });
});
