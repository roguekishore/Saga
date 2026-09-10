import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type CollectorHandle, startCollector } from '@saga/collector';
import { type Fixture, type ReplayHandle, startReplayUpstream } from '@saga/corpus';

/**
 * P1 latency gate: capture must add no client-visible delay. Medians of
 * direct-vs-proxied completion over a streamed response, same process, same
 * sockets. The assertion bound is deliberately CI-safe (25ms median overhead)
 * — the measured numbers are printed for the honest record; the master plan
 * target is <10ms collector overhead.
 */

function streamFixture(frames: number): Fixture {
  const sse: string[] = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"x","usage":{"input_tokens":100,"output_tokens":1}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  ];
  for (let i = 0; i < frames; i++) {
    sse.push(
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk ${i} of streamed payload padding padding padding"}}`,
    );
  }
  sse.push('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}');
  sse.push(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":420}}',
  );
  sse.push('event: message_stop\ndata: {"type":"message_stop"}');
  return {
    name: 'latency-probe',
    description: 'synthetic latency probe',
    request: { method: 'POST', path: '/v1/messages', headers: {}, body: null },
    response: {
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      sseFrames: sse,
      chunkBytes: 512,
      frameDelayMs: 1,
    },
  };
}

const BODY = JSON.stringify({
  model: 'claude-sonnet-4',
  stream: true,
  max_tokens: 512,
  system: 'latency harness',
  messages: [{ role: 'user', content: 'stream a lot of chunks' }],
});

let replay: ReplayHandle;
let collector: CollectorHandle;

beforeAll(() => {
  replay = startReplayUpstream([streamFixture(60)]);
  collector = startCollector({
    host: '127.0.0.1',
    proxyPort: 0,
    apiPort: 0,
    upstream: replay.url,
    dbPath: ':memory:',
    queueCapacity: 4096,
  });
});

afterAll(() => {
  collector.stop();
  replay.stop();
});

async function timeOne(url: string): Promise<{ total: number; ttfb: number }> {
  const t0 = performance.now();
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: BODY,
  });
  const reader = res.body!.getReader();
  let ttfb = -1;
  for (;;) {
    const { done } = await reader.read();
    if (ttfb < 0) ttfb = performance.now() - t0;
    if (done) break;
  }
  return { total: performance.now() - t0, ttfb };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

describe('P1 gate: capture adds no client-visible delay', () => {
  test('median proxied overhead is within noise', async () => {
    const N = 24;
    const direct: number[] = [];
    const proxied: number[] = [];
    const directTtfb: number[] = [];
    const proxiedTtfb: number[] = [];

    // warmup both paths
    await timeOne(replay.url);
    await timeOne(`http://127.0.0.1:${collector.proxy.port}`);

    // interleave to spread scheduler noise evenly
    for (let i = 0; i < N; i++) {
      const d = await timeOne(replay.url);
      const p = await timeOne(`http://127.0.0.1:${collector.proxy.port}`);
      direct.push(d.total);
      proxied.push(p.total);
      directTtfb.push(d.ttfb);
      proxiedTtfb.push(p.ttfb);
    }

    const overheadTotal = median(proxied) - median(direct);
    const overheadTtfb = median(proxiedTtfb) - median(directTtfb);
    console.log(
      `[latency-gate] median direct=${median(direct).toFixed(1)}ms proxied=${median(proxied).toFixed(1)}ms ` +
        `overhead=${overheadTotal.toFixed(2)}ms | ttfb direct=${median(directTtfb).toFixed(1)}ms ` +
        `proxied=${median(proxiedTtfb).toFixed(1)}ms overhead=${overheadTtfb.toFixed(2)}ms ` +
        `(n=${N}, master-plan target <10ms, CI bound 25ms)`,
    );

    expect(overheadTotal).toBeLessThan(25);
    expect(overheadTtfb).toBeLessThan(25);
  }, 60_000);

  test('capture kept up: nothing dropped, everything persisted', () => {
    collector.queue.flushSync();
    const stats = collector.queue.stats();
    expect(stats.dropped).toBe(0);
    const n = collector.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM requests WHERE status = 'ok'`)
      .get();
    expect(Number(n?.n)).toBeGreaterThanOrEqual(25);
  });
});
