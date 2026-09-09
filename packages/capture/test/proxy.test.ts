import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createAdapters } from '@saga/adapters';
import type { NormalizedEvent, RequestStarted, ResponseFinished } from '@saga/contracts';
import { type ProxyHandle, startProxy } from '../src/proxy';

/**
 * End-to-end proxy tests against a real in-process upstream that streams SSE
 * with deliberately hostile chunk boundaries. This is the forward-path
 * isolation proof: byte-identical client payloads, capture off the hot path.
 */

const FAKE_KEY = 'sk-ant-api03-PLANTEDfakePLANTEDfakePLANTED12345678901234';

const SSE_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4","usage":{"input_tokens":321,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering deeply"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"c2lnbmF0dXJl"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"is 42."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

let upstream: ReturnType<typeof Bun.serve>;
let proxy: ProxyHandle;
let events: NormalizedEvent[] = [];

beforeAll(() => {
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages') {
        const whole = SSE_FRAMES.join('');
        // Hostile chunking: cut the byte stream every 7 bytes so nearly every
        // frame is split mid-record — the tail buffer must reassemble.
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const bytes = new TextEncoder().encode(whole);
            for (let i = 0; i < bytes.length; i += 7) {
              controller.enqueue(bytes.slice(i, i + 7));
              if (i % 210 === 0) await new Promise((r) => setTimeout(r, 1));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      }
      if (url.pathname === '/v1/models') {
        return Response.json({ data: [{ id: 'claude-sonnet-4' }] });
      }
      if (url.pathname === '/fail') {
        return Response.json({ error: { type: 'overloaded', message: 'nope' } }, { status: 529 });
      }
      return new Response('not found', { status: 404 });
    },
  });

  events = [];
  proxy = startProxy({
    host: '127.0.0.1',
    port: 0,
    upstream: `http://127.0.0.1:${upstream.port}`,
    adapters: createAdapters({ usageSource: 'gateway-computed' }),
    emit: (ev) => events.push(ev),
  });
});

afterAll(() => {
  proxy.stop();
  upstream.stop(true);
});

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for events');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('proxy end to end', () => {
  test('SSE passes through byte-identical; events derived with usage off message_start', async () => {
    events.length = 0;
    const body = JSON.stringify({
      model: 'claude-sonnet-4',
      stream: true,
      max_tokens: 128,
      system: 'terse',
      messages: [{ role: 'user', content: `use ${FAKE_KEY} to auth` }],
    });

    const direct = await fetch(`http://127.0.0.1:${upstream.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const directText = await direct.text();

    const viaProxy = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${FAKE_KEY}`,
        'user-agent': 'saga-test-client/1.0',
      },
      body,
    });
    const proxiedText = await viaProxy.text();

    // The client sees EXACTLY what the upstream sent.
    expect(proxiedText).toBe(directText);
    expect(viaProxy.headers.get('x-saga-request-id')).toStartWith('req_');

    await waitFor(() => events.some((e) => e.kind === 'response_finished'));

    const started = events.find((e) => e.kind === 'request_started') as RequestStarted;
    expect(started.adapterId).toBe('anthropic');
    expect(started.sessionId).toStartWith('ses_');
    expect(started.model).toBe('claude-sonnet-4');

    const ft = events.find((e) => e.kind === 'first_token');
    expect(ft).toBeDefined();

    const fin = events.find((e) => e.kind === 'response_finished') as ResponseFinished;
    expect(fin.status).toBe('ok');
    expect(fin.httpStatus).toBe(200);
    expect(fin.usage.input).toEqual({ value: 321, source: 'gateway-computed' });
    expect(fin.usage.output).toEqual({ value: 57, source: 'gateway-computed' });
    expect(fin.usage.cacheRead).toBeNull();
    expect(fin.stopReason).toBe('end_turn');
    expect(fin.ttftMs).not.toBeNull();
    expect(fin.latencyMs).toBeGreaterThan(0);
    const types = fin.message?.blocks.map((b) => b.type);
    expect(types).toEqual(['thinking', 'text']);
    const think = fin.message?.blocks[0];
    if (think?.type === 'thinking') expect(think.signature).toBe('c2lnbmF0dXJl');
  });

  test('no planted secret appears in ANY emitted event', async () => {
    const all = JSON.stringify(events);
    expect(all).not.toContain(FAKE_KEY);
    expect(all).toContain('[REDACTED:'); // proof scrubbing ran, not dropped
  });

  test('token_stream ticks were throttled and carry block types', () => {
    const ticks = events.filter((e) => e.kind === 'token_stream');
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      if (t.kind === 'token_stream') {
        expect(['text', 'thinking', 'tool_use', 'unknown']).toContain(t.blockType);
      }
    }
  });

  test('non-SSE JSON routes pass through via the passthrough adapter', async () => {
    events.length = 0;
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data[0]?.id).toBe('claude-sonnet-4');
    await waitFor(() => events.some((e) => e.kind === 'response_finished'));
    const started = events.find((e) => e.kind === 'request_started') as RequestStarted;
    expect(started.adapterId).toBe('passthrough');
    const fin = events.find((e) => e.kind === 'response_finished') as ResponseFinished;
    expect(fin.usage.input).toBeNull(); // no invented numbers
  });

  test('upstream HTTP error becomes upstream_error with redacted detail', async () => {
    events.length = 0;
    const res = await fetch(`http://127.0.0.1:${proxy.port}/fail`, { method: 'GET' });
    expect(res.status).toBe(529);
    await waitFor(() => events.some((e) => e.kind === 'response_finished'));
    const fin = events.find((e) => e.kind === 'response_finished') as ResponseFinished;
    expect(fin.status).toBe('upstream_error');
    expect(fin.httpStatus).toBe(529);
  });

  test('unreachable upstream → 502 to client, upstream_error event, proxy alive', async () => {
    const deadProxy = startProxy({
      host: '127.0.0.1',
      port: 0,
      upstream: 'http://127.0.0.1:9', // discard port; nothing listens
      adapters: createAdapters({ usageSource: 'gateway-computed' }),
      emit: (ev) => events.push(ev),
    });
    try {
      events.length = 0;
      const res = await fetch(`http://127.0.0.1:${deadProxy.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      expect(res.status).toBe(502);
      const j = (await res.json()) as { error: { type: string } };
      expect(j.error.type).toBe('saga_upstream_unreachable');
      await waitFor(() => events.some((e) => e.kind === 'response_finished'));
      const fin = events.find((e) => e.kind === 'response_finished') as ResponseFinished;
      expect(fin.status).toBe('upstream_error');
      expect(fin.httpStatus).toBeNull();
    } finally {
      deadProxy.stop();
    }
  });

  test('a hostile capture layer cannot corrupt the client stream', async () => {
    // Adapter whose observer throws on every frame and whose normalize throws.
    const hostile = {
      id: 'hostile',
      provider: 'hostile',
      displayName: 'Hostile',
      matches: () => true,
      normalizeRequest: () => {
        throw new Error('normalize exploded');
      },
      createObserver: () => ({
        onFrame: () => {
          throw new Error('frame exploded');
        },
        onCompleteBody: () => {
          throw new Error('body exploded');
        },
        sawFirstContent: () => false,
        outputTokensSoFar: () => null,
        finalize: () => {
          throw new Error('finalize exploded');
        },
      }),
    };
    const hostileProxy = startProxy({
      host: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${upstream.port}`,
      adapters: [hostile],
      emit: (ev) => events.push(ev),
    });
    try {
      events.length = 0;
      const direct = await (
        await fetch(`http://127.0.0.1:${upstream.port}/v1/messages`, {
          method: 'POST',
          body: '{}',
        })
      ).text();
      const proxied = await (
        await fetch(`http://127.0.0.1:${hostileProxy.port}/v1/messages`, {
          method: 'POST',
          body: '{}',
        })
      ).text();
      expect(proxied).toBe(direct); // forward path untouched by capture chaos
      await waitFor(() => events.some((e) => e.kind === 'capture_error'));
      expect(events.some((e) => e.kind === 'capture_error')).toBe(true);
    } finally {
      hostileProxy.stop();
    }
  });
});
