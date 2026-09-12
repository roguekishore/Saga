import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CollectorHandle, startCollector } from '@saga/collector';
import { loadFixtures, type ReplayHandle, startReplayUpstream } from '@saga/corpus';

/**
 * THE P1 redaction gate: planted secrets go through the FULL stack into a
 * REAL file-backed database, then the raw db + wal bytes are scanned — the
 * `strings`-equivalent proof. "No secret reached disk" is asserted by this
 * suite, never by inspection.
 */

const PLANTED_SECRETS = [
  'sk-ant-api03-PLANTEDproxyheaderPLANTEDproxyheader123456', // authorization header
  'sk-ant-api03-PLANTEDsystemPLANTEDsystemPLANTED123456', // system prompt
  'AKIAPLANTEDFAKE00001', // aws access key id
  'PLANTEDfake1234PLANTEDfake5678PLANTEDfke', // aws secret
  'ghp_PLANTEDfakePLANTEDfakePLANTEDfake0001', // github pat
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.PLANTEDsigPLANTEDsigPLANTED', // jwt
  'hunter2hunter2', // password: assignment
  'q7Rt2xKp9mWz4Lc8Vn3Yb6Hd1Fs5Gj0QaZwSxEd', // unrecognized entropy blob
  'sk-proj-PLANTEDfake2PLANTEDfake2PLANTEDfake2PLANTED', // openai key in tool_result
  'sk-ant-api03-PLANTEDresponsePLANTEDresponse9876', // response-side echo
  'xoxb-1234567890-PLANTEDRESPfake', // slack token in response
];

let dir: string;
let dbPath: string;
let replay: ReplayHandle;
let collector: CollectorHandle;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'saga-redaction-gate-'));
  dbPath = join(dir, 'gate.db');
  const fixtures = loadFixtures();
  replay = startReplayUpstream(fixtures);
  collector = startCollector({
    host: '127.0.0.1',
    proxyPort: 0,
    apiPort: 0,
    upstream: replay.url,
    dbPath,
    queueCapacity: 1024,
  });

  const fx = fixtures.find((f) => f.name === 'secrets-planted')!;
  const res = await fetch(`http://127.0.0.1:${collector.proxy.port}${fx.request.path}`, {
    method: fx.request.method,
    headers: { ...fx.request.headers, 'x-saga-fixture': fx.name },
    body: JSON.stringify(fx.request.body),
  });
  const proxiedText = await res.text();
  // The CLIENT still received the raw upstream bytes (SAGA never mutates the
  // stream) — redaction protects the disk, not the wire.
  expect(proxiedText).toContain('PLANTEDresponse');

  await new Promise((r) => setTimeout(r, 250));
  collector.queue.flushSync();
});

afterAll(() => {
  collector.stop();
  replay.stop();
  // Windows holds the sqlite file briefly after close, so removing the temp dir
  // races and throws EBUSY. A throw here fails the suite on a cleanup step that
  // is not what this gate asserts — every secret-absence assertion has already
  // run against the real db + wal bytes by this point. Retry, then leave the
  // directory to the OS rather than turning a tmpdir race into a red gate.
  //
  // Same treatment `retention.test.ts` already applies for the same reason.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // handle still held; the OS reclaims the temp dir
  }
});

describe('P1 gate: a planted secret is provably absent from disk', () => {
  test('every planted secret is absent from db + wal bytes', () => {
    // Scan BEFORE close/checkpoint so the wal is still live — the honest case.
    const blobs: Buffer[] = [readFileSync(dbPath)];
    if (existsSync(`${dbPath}-wal`)) blobs.push(readFileSync(`${dbPath}-wal`));
    const haystack = Buffer.concat(blobs);
    expect(haystack.byteLength).toBeGreaterThan(0);

    for (const secret of PLANTED_SECRETS) {
      expect(haystack.includes(Buffer.from(secret, 'utf-8'))).toBe(false);
    }
  });

  test('placeholders prove scrubbing ran (content was redacted, not dropped)', async () => {
    const api = `http://127.0.0.1:${collector.api.port}`;
    const list = (await (await fetch(`${api}/api/requests`)).json()) as {
      items: Array<{ requestId: string; redactionFlagged: boolean }>;
    };
    expect(list.items.length).toBe(1);
    const detail = JSON.stringify(
      await (await fetch(`${api}/api/requests/${list.items[0]!.requestId}`)).json(),
    );
    expect(detail).toContain('[REDACTED:anthropic-key:');
    expect(detail).toContain('[REDACTED:aws-access-key-id:');
    expect(detail).toContain('[REDACTED:github-pat:');
    expect(detail).toContain('[REDACTED:jwt:');
    expect(detail).toContain('[REDACTED:entropy-suspect:');
    // fail-closed: the unrecognized blob flagged the request visibly
    expect(list.items[0]!.redactionFlagged).toBe(true);
    // and none of the secrets leaked into API payloads either
    for (const secret of PLANTED_SECRETS) {
      expect(detail).not.toContain(secret);
    }
  });

  test('the planted-secret fixture stays synthetic (never a recording)', () => {
    const fx = loadFixtures().find((f) => f.name === 'secrets-planted')!;
    expect(fx.description.toLowerCase()).toContain('hand-authored');
    expect(JSON.stringify(fx)).toContain('PLANTED');
  });
});
