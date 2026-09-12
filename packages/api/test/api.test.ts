import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SqliteAnalytics } from '@saga/analytics';
import {
  ContextGrowthSchema,
  HealthSchema,
  LatencySeriesSchema,
  type NormalizedEvent,
  type NormalizedMessage,
  OverviewSchema,
  RequestDetailSchema,
  RequestListSchema,
  SearchResultSchema,
  SessionListSchema,
  SettingsSchema,
  StorageInfoSchema,
  TokenSeriesSchema,
  WsServerMessageSchema,
} from '@saga/contracts';
import { MIGRATIONS, openDatabase, runMigrations, StoreWriter } from '@saga/store';
import { type ApiServerHandle, startApiServer } from '../src/server';

/**
 * Contract-pinning suite: every REST payload must parse against the FROZEN
 * schema it claims to implement. If the server drifts from the contract the
 * dashboard codes against, this fails before any page does.
 */

let api: ApiServerHandle;
let base: string;
const subscribers: Array<(ev: NormalizedEvent) => void> = [];
const pushEvent = (ev: NormalizedEvent): void => {
  for (const s of subscribers) s(ev);
};

function msg(text: string, role: NormalizedMessage['role'] = 'user'): NormalizedMessage {
  return {
    role,
    blocks: [{ type: 'text', text }],
    contextSource: role === 'system' ? 'system' : role,
    contextSourceInferred: false,
  };
}

beforeAll(async () => {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS);
  const writer = new StoreWriter(db);

  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const rid = `req_seed_${String(i).padStart(2, '0')}`;
    writer.handleEvent({
      kind: 'request_started',
      requestId: rid,
      ts: now - (6 - i) * 60_000,
      sessionId: 'ses_seed',
      sessionIdSource: 'inferred',
      clientSessionId: null,
      adapterId: 'anthropic',
      provider: 'anthropic-messages',
      endpoint: '/v1/messages',
      method: 'POST',
      upstreamUrl: 'http://127.0.0.1:8000',
      clientName: 'seed-client',
      workspace: '/w/proj',
      model: i % 2 ? 'claude-sonnet-4' : 'claude-haiku-3',
      stream: true,
      request: {
        model: i % 2 ? 'claude-sonnet-4' : 'claude-haiku-3',
        stream: true,
        system: [msg('you answer briefly about sqlite vacuum policies', 'system')],
        messages: [msg(`turn ${i}: how does the vacuum policy interact with retention?`)],
        tools: [{ name: 'Read', descriptionBytes: 11, inputSchemaBytes: 20 }],
        paramsJson: '{"max_tokens":256}',
        rawRequestJson: `{"model":"m","turn":${i}}`,
      },
      redaction: { hits: [{ kind: 'bearer-token', count: 1 }], flagged: false },
      // WS-C hierarchy fields. Explicit rather than defaulted: `z.default()` is
      // input-optional but OUTPUT-required, the same reason `sessionIdSource`
      // above is spelled out — an emitter must not be able to omit one and have
      // it read as wire truth.
      door: 'A',
      harness: 'claude-code',
      routingTier: null,
      turn: null,
      callRole: null,
      harnessIdentity: null,
      injections: [],
    });
    writer.handleEvent({
      kind: 'first_token',
      requestId: rid,
      ts: now - (6 - i) * 60_000 + 200,
      ttftMs: 200,
    });
    writer.handleEvent({
      kind: 'response_finished',
      requestId: rid,
      ts: now - (6 - i) * 60_000 + 900,
      status: i === 5 ? 'upstream_error' : 'ok',
      httpStatus: i === 5 ? 529 : 200,
      latencyMs: 700 + i * 50,
      ttftMs: 200,
      usage: {
        input: { value: 1000 + i, source: 'gateway-computed' },
        output: { value: 100 + i, source: 'gateway-computed' },
        cacheRead: null,
        cacheWrite: null,
      },
      stopReason: i === 5 ? null : 'end_turn',
      message:
        i === 5
          ? null
          : {
              role: 'assistant',
              blocks: [
                { type: 'thinking', thinking: 'considering…', signature: 'sig' },
                { type: 'text', text: `answer ${i} about vacuum` },
              ],
              contextSource: 'assistant',
              contextSourceInferred: false,
            },
      error: i === 5 ? { type: 'overloaded', message: 'Overloaded' } : null,
      frameStats: { frames: 10, bytes: 2000, parseErrors: 0 },
      redaction: { hits: [], flagged: false },
    });
  }

  api = startApiServer({
    host: '127.0.0.1',
    port: 0,
    db,
    dbPath: ':memory:',
    analytics: new SqliteAnalytics(db),
    events: {
      subscribe: (fn) => {
        subscribers.push(fn);
        return () => {};
      },
      stats: () => ({ depth: 0, capacity: 2048, dropped: 0 }),
    },
    proxy: {
      host: '127.0.0.1',
      port: 8787,
      upstream: 'http://127.0.0.1:8000',
      activeRequests: () => 0,
    },
    version: '0.1.0-test',
    metricsIntervalMs: 60,
  });
  base = `http://127.0.0.1:${api.port}`;
});

afterAll(() => api.stop());

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(base + path);
  expect(res.ok).toBe(true);
  return res.json();
}

describe('ReadAPI honors the frozen contracts', () => {
  test('health', async () => {
    HealthSchema.parse(await getJson('/api/health'));
  });

  test('overview: aggregates carry sources; cache/cost are null, not 0', async () => {
    const o = OverviewSchema.parse(await getJson('/api/overview'));
    expect(o.requestsToday).toBe(6);
    expect(o.tokensToday.output.sources).toEqual(['gateway-computed']);
    expect(o.cacheHitRatio).toBeNull();
    expect(o.costToday).toBeNull();
    expect(o.p95LatencyMs).not.toBeNull();
    expect(o.recentErrors.length).toBe(1);
  });

  test('request list with filters and keyset pagination', async () => {
    const page1 = RequestListSchema.parse(await getJson('/api/requests?limit=4'));
    expect(page1.items.length).toBe(4);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = RequestListSchema.parse(
      await getJson(`/api/requests?limit=4&cursor=${page1.nextCursor}`),
    );
    expect(page2.items.length).toBe(2);
    const ids = new Set([...page1.items, ...page2.items].map((i) => i.requestId));
    expect(ids.size).toBe(6);

    const errs = RequestListSchema.parse(await getJson('/api/requests?status=upstream_error'));
    expect(errs.items.length).toBe(1);
    expect(errs.items[0]?.errorMessage).toBe('Overloaded');
  });

  test('request detail: messages decompress, thinking block survives, provenance intact', async () => {
    const d = RequestDetailSchema.parse(await getJson('/api/requests/req_seed_02'));
    expect(d.request.system[0]?.blocks[0]?.type).toBe('text');
    expect(d.request.messages.length).toBe(1);
    expect(d.request.tools[0]?.name).toBe('Read');
    expect(d.request.rawRequestJson).toContain('"turn":2');
    const think = d.response.message?.blocks[0];
    expect(think?.type).toBe('thinking');
    if (think?.type === 'thinking') expect(think.signature).toBe('sig');
    expect(d.response.usage.input?.source).toBe('gateway-computed');
    expect(d.response.usage.cacheRead).toBeNull();
    expect(d.timeline.firstTokenAt).not.toBeNull();
    expect(d.redaction.hits[0]?.kind).toBe('bearer-token');
  });

  test('firstObservedAt dates the first sighting, so dedup exposes carried-over context', async () => {
    const first = RequestDetailSchema.parse(await getJson('/api/requests/req_seed_00'));
    const later = RequestDetailSchema.parse(await getJson('/api/requests/req_seed_02'));

    // The seed sends a byte-identical system prompt on every turn. Dedup stores
    // it once and ON CONFLICT never rewrites created_at, so turn 2 reports the
    // stamp of turn 0 -- and it predates turn 2's own ts. That inequality IS
    // the carried-over-context signal the UI renders.
    const sysFirst = first.request.system[0]?.firstObservedAt;
    const sysLater = later.request.system[0]?.firstObservedAt;
    expect(sysFirst).toBe(first.summary.ts);
    expect(sysLater).toBe(sysFirst);
    expect(sysLater!).toBeLessThan(later.summary.ts);

    // The user turn is unique per request, so it is genuinely new input: its
    // first sighting is this request.
    expect(later.request.messages[0]?.firstObservedAt).toBe(later.summary.ts);
    expect(later.response.message?.firstObservedAt).not.toBeNull();
  });

  test('sessions list marks inference and aggregates with sources', async () => {
    const s = SessionListSchema.parse(await getJson('/api/sessions'));
    expect(s.items.length).toBe(1);
    expect(s.items[0]?.inferred).toBe(true);
    expect(s.items[0]?.requests).toBe(6);
    expect(s.items[0]?.outputTokens.sources).toEqual(['gateway-computed']);
  });

  test('search hits map back to requests with snippets', async () => {
    const r = SearchResultSchema.parse(await getJson('/api/search?q=vacuum'));
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]?.snippet.toLowerCase()).toContain('vacuum');
    expect(r.items[0]?.requestId).toStartWith('req_seed_');
  });

  test('analytics endpoints parse against contracts', async () => {
    const from = Date.now() - 86_400_000;
    const to = Date.now() + 1;
    const tok = TokenSeriesSchema.parse(
      await getJson(`/api/analytics/tokens?from=${from}&to=${to}&bucket=hour&groupBy=model`),
    );
    expect(tok.series.length).toBeGreaterThan(0);
    expect(tok.series[0]?.output.sources).toEqual(['gateway-computed']);

    const lat = LatencySeriesSchema.parse(
      await getJson(`/api/analytics/latency?from=${from}&to=${to}&bucket=hour`),
    );
    expect(lat.sample.length).toBe(6);
    expect(lat.series[0]?.p95).not.toBeNull();

    const g = ContextGrowthSchema.parse(
      await getJson('/api/analytics/context-growth?sessionId=ses_seed'),
    );
    expect(g.points.length).toBe(6);
    expect(g.points[5]?.turn).toBe(6);
  });

  test('storage reports dedup and compression honestly', async () => {
    const s = StorageInfoSchema.parse(await getJson('/api/storage'));
    expect(s.requestCount).toBe(6);
    // The shared system prompt deduped: 6 requests but fewer message rows
    // than 6 * (system+user+assistant+raw).
    expect(s.messageCount).toBeLessThan(24);
    expect(s.dedupSavedBytes).toBeGreaterThan(0);
  });

  test('settings state the loopback boundary', async () => {
    const s = SettingsSchema.parse(await getJson('/api/settings'));
    expect(s.securityNote).toContain('loopback');
    expect(s.proxy.host).toBe('127.0.0.1');
  });

  test('websocket: hello, event relay, metrics heartbeat — all schema-valid', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/ws`);
    const messages: unknown[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws failed'));
    });
    pushEvent({ kind: 'first_token', requestId: 'req_live', ts: Date.now(), ttftMs: 99 });
    await new Promise((r) => setTimeout(r, 150)); // hello + event + ≥1 metrics tick
    ws.close();

    expect(messages.length).toBeGreaterThanOrEqual(3);
    const parsed = messages.map((m) => WsServerMessageSchema.parse(m));
    expect(parsed[0]?.type).toBe('hello');
    expect(parsed.some((m) => m.type === 'event' && m.event.requestId === 'req_live')).toBe(true);
    expect(parsed.some((m) => m.type === 'metrics')).toBe(true);
  });
});
