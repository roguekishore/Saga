import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type CollectorHandle, startCollector } from '@saga/collector';
import {
  OverviewSchema,
  RequestDetailSchema,
  RequestListSchema,
  SearchResultSchema,
  SessionListSchema,
} from '@saga/contracts';
import { loadFixtures, type ReplayHandle, startReplayUpstream } from '@saga/corpus';

/**
 * Full-stack e2e against the replay upstream: real sockets, real SSE with
 * hostile chunking, the real proxy → queue → writer → API pipeline. This is
 * the corpus standing in for the live gateway (which is unreachable on this
 * machine — ground truth 2026-09-03).
 */

let replay: ReplayHandle;
let collector: CollectorHandle;
let proxyUrl: string;
let apiUrl: string;

const fixtures = loadFixtures();

async function replayThrough(name: string): Promise<Response> {
  const fx = fixtures.find((f) => f.name === name);
  if (!fx) throw new Error(`missing fixture ${name}`);
  const res = await fetch(proxyUrl + fx.request.path, {
    method: fx.request.method,
    headers: { ...fx.request.headers, 'x-saga-fixture': fx.name },
    body: fx.request.body == null ? undefined : JSON.stringify(fx.request.body),
  });
  await res.text();
  return res;
}

async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  collector.queue.flushSync();
}

beforeAll(async () => {
  replay = startReplayUpstream(fixtures);
  collector = startCollector({
    host: '127.0.0.1',
    proxyPort: 0,
    apiPort: 0,
    upstream: replay.url,
    dbPath: ':memory:',
    queueCapacity: 4096,
  });
  proxyUrl = `http://127.0.0.1:${collector.proxy.port}`;
  apiUrl = `http://127.0.0.1:${collector.api.port}`;

  for (const name of [
    'anthropic-stream-thinking-tools',
    'session-turn-1',
    'session-turn-2',
    'session-turn-3',
    'openai-stream-basic',
    'anthropic-error-overloaded',
  ]) {
    await replayThrough(name);
  }
  await settle();
});

afterAll(() => {
  collector.stop();
  replay.stop();
});

describe('P1 vertical slice, end to end', () => {
  test('client stream through SAGA is byte-identical to the upstream stream', async () => {
    const fx = fixtures.find((f) => f.name === 'anthropic-stream-thinking-tools')!;
    const direct = await (
      await fetch(replay.url + fx.request.path, {
        method: 'POST',
        headers: { 'x-saga-fixture': fx.name },
        body: JSON.stringify(fx.request.body),
      })
    ).text();
    const proxied = await (
      await fetch(proxyUrl + fx.request.path, {
        method: 'POST',
        headers: { 'x-saga-fixture': fx.name },
        body: JSON.stringify(fx.request.body),
      })
    ).text();
    expect(proxied).toBe(direct);
    await settle();
  });

  test('overview reflects the replayed traffic with honest nulls', async () => {
    const o = OverviewSchema.parse(await (await fetch(`${apiUrl}/api/overview`)).json());
    expect(o.requestsToday).toBeGreaterThanOrEqual(6);
    expect(o.tokensToday.output.value).toBeGreaterThan(0);
    expect(o.tokensToday.output.sources).toEqual(['gateway-computed']);
    expect(o.cacheHitRatio).toBeNull(); // nothing produces cache fields here
    expect(o.costToday).toBeNull(); // no price table applies — never invented
  });

  test('thinking block with signature and split tool_use survived the wire → disk → API trip', async () => {
    const list = RequestListSchema.parse(
      await (await fetch(`${apiUrl}/api/requests?limit=50`)).json(),
    );
    const target = list.items.find((i) => i.toolUseCount > 0 && i.stream);
    expect(target).toBeDefined();
    const d = RequestDetailSchema.parse(
      await (await fetch(`${apiUrl}/api/requests/${target!.requestId}`)).json(),
    );
    const types = d.response.message?.blocks.map((b) => b.type);
    expect(types).toEqual(['thinking', 'text', 'tool_use']);
    const think = d.response.message?.blocks[0];
    if (think?.type === 'thinking') {
      expect(think.signature).toBe('RmFrZVNpZ25hdHVyZUZvckZpeHR1cmU=');
    }
    const tool = d.response.message?.blocks[2];
    if (tool?.type === 'tool_use') {
      expect(tool.name).toBe('run_shell');
      expect(tool.input).toEqual({ command: 'ls -la' });
    }
    // usage came off message_start/message_delta, labeled gateway-computed
    expect(d.response.usage.input).toEqual({ value: 412, source: 'gateway-computed' });
    expect(d.response.usage.output).toEqual({ value: 58, source: 'gateway-computed' });
    // workspace heuristic found the fixture's stated working directory
    expect(d.summary.sessionId).toStartWith('ses_');
  });

  test('three turns with one system prompt land in one inferred session with dedup', async () => {
    const sessions = SessionListSchema.parse(await (await fetch(`${apiUrl}/api/sessions`)).json());
    const demo = sessions.items.find((s) => s.requests >= 3);
    expect(demo).toBeDefined();
    expect(demo!.inferred).toBe(true);

    const storage = (await (await fetch(`${apiUrl}/api/storage`)).json()) as {
      dedupSavedBytes: number;
    };
    expect(storage.dedupSavedBytes).toBeGreaterThan(0);
  });

  test('openai dialect normalized by its own adapter on the same upstream', async () => {
    const list = RequestListSchema.parse(
      await (await fetch(`${apiUrl}/api/requests?adapterId=openai`)).json(),
    );
    expect(list.items.length).toBe(1);
    const d = RequestDetailSchema.parse(
      await (await fetch(`${apiUrl}/api/requests/${list.items[0]!.requestId}`)).json(),
    );
    const types = d.response.message?.blocks.map((b) => b.type);
    expect(types).toEqual(['thinking', 'text']); // reasoning_content → thinking
    expect(d.response.usage.input?.value).toBe(58);
  });

  test('upstream error is recorded as upstream_error with its message', async () => {
    const list = RequestListSchema.parse(
      await (await fetch(`${apiUrl}/api/requests?status=upstream_error`)).json(),
    );
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    expect(list.items[0]?.httpStatus).toBe(529);
  });

  test('FTS search finds fixture prose and maps to requests', async () => {
    const r = SearchResultSchema.parse(
      await (await fetch(`${apiUrl}/api/search?q=freelist`)).json(),
    );
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]?.snippet.toLowerCase()).toContain('freelist');
  });

  test('queue shed nothing during the replay and capture reported no errors', async () => {
    const stats = collector.queue.stats();
    expect(stats.dropped).toBe(0);
    expect(stats.subscriberErrors).toBe(0);
    expect(collector.writer.writeErrors).toBe(0);
  });
});
