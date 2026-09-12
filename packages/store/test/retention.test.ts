import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage, RequestStarted, ResponseFinished } from '@saga/contracts';
import { type Driver, openDatabase } from '../src/driver';
import { runMigrations } from '../src/migrate';
import { MIGRATIONS } from '../src/migrations';
import { DEFAULT_RETENTION, runRetention } from '../src/retention';
import { StoreWriter } from '../src/writer';

const DAY = 86_400_000;
const NOW = 1_788_000_000_000;

const dirs: string[] = [];
const dbs: Driver[] = [];
afterEach(() => {
  while (dbs.length) {
    try {
      dbs.pop()!.close();
    } catch {
      // already closed by the test itself
    }
  }
  // Best-effort unlink. On Windows the retention delete path keeps a handle on
  // the db file alive past close() — POSIX unlinks open files happily, but on
  // Windows rmSync raises EBUSY. These are mkdtemp directories under the OS
  // temp dir, so a failed unlink leaks a few KB the OS reclaims — never a
  // reason to fail a passing assertion.
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // handle still held; leave it to the OS
    }
  }
});

function msg(text: string, role: NormalizedMessage['role'] = 'user'): NormalizedMessage {
  return {
    role,
    blocks: [{ type: 'text', text }],
    contextSource: role === 'system' ? 'system' : role,
    contextSourceInferred: false,
  };
}

function seedRequest(writer: StoreWriter, id: string, ts: number, marker: string): void {
  const started: RequestStarted = {
    kind: 'request_started',
    requestId: id,
    ts,
    sessionId: `ses_${id}`,
    sessionIdSource: 'inferred',
    clientSessionId: null,
    adapterId: 'anthropic',
    provider: 'anthropic-messages',
    endpoint: '/v1/messages',
    method: 'POST',
    upstreamUrl: 'http://u',
    clientName: 'c',
    workspace: null,
    model: 'm',
    stream: true,
    request: {
      model: 'm',
      stream: true,
      system: [msg(`system prompt ${marker}`, 'system')],
      messages: [msg(`unique user prompt ${marker} ${id}`)],
      tools: [],
      paramsJson: '{}',
      rawRequestJson: `{"marker":"${marker}","id":"${id}","pad":"${'x'.repeat(800)}"}`,
    },
    redaction: { hits: [], flagged: false },
    // WS-C hierarchy fields. Spelled out rather than defaulted because
    // `z.default()` is input-optional but OUTPUT-required, which is the same
    // reason `sessionIdSource` is explicit above: an emitter cannot quietly omit
    // one and have it read as wire truth. These values are what the C3 stubs
    // return today, so this fixture also pins the unclassified state.
    door: 'A',
    harness: 'claude-code',
    routingTier: null,
    turn: null,
    callRole: null,
    harnessIdentity: null,
    injections: [],
  };
  const finished: ResponseFinished = {
    kind: 'response_finished',
    requestId: id,
    ts: ts + 500,
    status: 'ok',
    httpStatus: 200,
    latencyMs: 500,
    ttftMs: 100,
    usage: {
      input: { value: 100, source: 'gateway-computed' },
      output: { value: 10, source: 'gateway-computed' },
      cacheRead: null,
      cacheWrite: null,
    },
    stopReason: 'end_turn',
    message: msg(`assistant answer ${marker} ${id}`, 'assistant'),
    error: null,
    frameStats: { frames: 3, bytes: 100, parseErrors: 0 },
    redaction: { hits: [], flagged: false },
  };
  writer.handleEvent(started);
  writer.handleEvent(finished);
}

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'saga-retention-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'r.db'));
  dbs.push(db);
  runMigrations(db, MIGRATIONS);
  const writer = new StoreWriter(db);
  seedRequest(writer, 'req_hot', NOW - 1 * DAY, 'hotmark');
  seedRequest(writer, 'req_warm', NOW - 45 * DAY, 'warmmark');
  seedRequest(writer, 'req_cold', NOW - 120 * DAY, 'coldmark');
  seedRequest(writer, 'req_arch', NOW - 400 * DAY, 'archmark');
  return { db };
}

describe('retention tiers + vacuum policy', () => {
  test('tiers marked; cold drops inputs keeps summary; archive drops all; metrics survive', () => {
    const { db } = build();
    const report = runRetention(db, DEFAULT_RETENTION, NOW);

    expect(report.tiered).toEqual({ warm: 1, cold: 1, archive: 1 });

    const tierOf = (id: string) =>
      db.prepare<{ tier: string }>('SELECT tier FROM requests WHERE request_id = ?').get(id)?.tier;
    expect(tierOf('req_hot')).toBe('hot');
    expect(tierOf('req_warm')).toBe('warm');
    expect(tierOf('req_cold')).toBe('cold');
    expect(tierOf('req_arch')).toBe('archive');

    const segs = (id: string) =>
      db
        .prepare<{ segment: string }>(
          'SELECT segment FROM request_messages WHERE request_id = ? ORDER BY seq',
        )
        .all(id)
        .map((r) => r.segment);
    expect(segs('req_hot')).toEqual(['system', 'input', 'output']);
    expect(segs('req_warm')).toEqual(['system', 'input', 'output']);
    expect(segs('req_cold')).toEqual(['system', 'output']); // summary = system + answer
    expect(segs('req_arch')).toEqual([]);

    // metrics rows intact for analytics — archive deletes bodies, not history
    const arch = db
      .prepare<{ output_tokens: number; latency_ms: number }>(
        'SELECT output_tokens, latency_ms FROM requests WHERE request_id = ?',
      )
      .get('req_arch');
    expect(arch?.output_tokens).toBe(10);
    expect(arch?.latency_ms).toBe(500);

    expect(report.messagesDeleted).toBeGreaterThan(0);
  });

  test('dropped bodies stop matching in FTS; kept bodies still match', () => {
    const { db } = build();
    runRetention(db, DEFAULT_RETENTION, NOW);
    const hits = (q: string) =>
      db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`)
        .get(`"${q}"`)?.n ?? 0;
    expect(hits('hotmark')).toBeGreaterThan(0);
    expect(hits(`archmark`)).toBe(0); // gone from the index
    // cold: the unique user prompt is gone, the assistant answer remains
    expect(hits('coldmark')).toBeGreaterThan(0);
    const coldUser = db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH '"unique user prompt coldmark"'`,
      )
      .get();
    expect(coldUser?.n).toBe(0);
  });

  test('idempotent: second run is a no-op', () => {
    const { db } = build();
    runRetention(db, DEFAULT_RETENTION, NOW);
    const second = runRetention(db, DEFAULT_RETENTION, NOW);
    expect(second.tiered).toEqual({ warm: 0, cold: 0, archive: 0 });
    expect(second.linksDeleted).toBe(0);
    expect(second.messagesDeleted).toBe(0);
  });

  test('vacuum reclaims freelist pages after deletion', () => {
    const { db } = build();
    // Force lots of garbage: add and immediately archive many big bodies.
    const writer = new StoreWriter(db);
    for (let i = 0; i < 60; i++) {
      seedRequest(writer, `req_bulk_${i}`, NOW - 400 * DAY, `bulk-${i}-${'y'.repeat(500)}`);
    }
    const before = Number(db.pragma('page_count'));
    const report = runRetention(db, { ...DEFAULT_RETENTION, vacuumFreelistRatio: 0.02 }, NOW);
    expect(report.vacuumed).toBe(true);
    expect(Number(db.pragma('freelist_count'))).toBe(0);
    expect(Number(db.pragma('page_count'))).toBeLessThan(before);
    const meta = db.prepare<{ v: string }>(`SELECT v FROM meta WHERE k = 'last_vacuum_at'`).get();
    expect(Number(meta?.v)).toBe(NOW);
  });
});
