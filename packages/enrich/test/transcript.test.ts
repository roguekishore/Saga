import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichSessions } from '../src/sessions';
import { factsFor, findTranscript, isTranscriptId, readTranscript } from '../src/transcript';

const SID = '595d6fa3-cc08-4e0f-abad-cacf6f8995f3';

/** A projects root shaped like Claude Code's, in a throwaway directory. */
function fixtureRoot(lines: unknown[], sessionId = SID, slug = 'D--PROJECTS-SAGA'): string {
  const root = mkdtempSync(join(tmpdir(), 'saga-enrich-'));
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(
    join(root, slug, `${sessionId}.jsonl`),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
    'utf-8',
  );
  return root;
}

describe('transcript id validation (the id comes off the wire)', () => {
  test('accepts a uuid, rejects everything else', () => {
    expect(isTranscriptId(SID)).toBe(true);
    expect(isTranscriptId('not-a-uuid')).toBe(false);
    expect(isTranscriptId('')).toBe(false);
    // A client controls this value, so traversal shapes must never pass.
    expect(isTranscriptId('../../../etc/passwd')).toBe(false);
    expect(isTranscriptId('..\\..\\windows\\system32\\config\\sam')).toBe(false);
    expect(isTranscriptId(`${SID}/../../elsewhere`)).toBe(false);
    expect(isTranscriptId(`${SID}\0`)).toBe(false);
  });

  test('a traversal id never reaches the filesystem', () => {
    const root = fixtureRoot([{ type: 'ai-title', aiTitle: 'x' }]);
    // Even with a real root present, a non-uuid id resolves to nothing.
    expect(findTranscript('../../../etc/passwd', root)).toBeNull();
    expect(factsFor('../../../etc/passwd', root)).toBeNull();
  });
});

describe('findTranscript', () => {
  test('finds the file under whichever project slug holds it', () => {
    const root = fixtureRoot([{ cwd: 'D:\\PROJECTS\\SAGA' }]);
    expect(findTranscript(SID, root)).toContain(`${SID}.jsonl`);
  });

  test('null for an unknown session and for a missing root', () => {
    const root = fixtureRoot([{ cwd: '/x' }]);
    expect(findTranscript('11111111-2222-3333-4444-555555555555', root)).toBeNull();
    expect(findTranscript(SID, join(root, 'does-not-exist'))).toBeNull();
  });
});

describe('readTranscript', () => {
  test('takes the LAST title, first cwd/branch, and per-model usage', () => {
    const root = fixtureRoot([
      { type: 'mode', mode: 'normal', sessionId: SID },
      { type: 'ai-title', aiTitle: 'first guess at a name', sessionId: SID },
      { type: 'user', cwd: 'D:\\PROJECTS\\SAGA', gitBranch: 'main' },
      { type: 'ai-title', aiTitle: 'conversation data rendering', sessionId: SID },
      {
        type: 'cost-state',
        sessionId: SID,
        totalCostUSD: 8.577185,
        startTime: 1788512522929,
        modelUsage: {
          'claude-opus-5[1m]': {
            inputTokens: 8157294,
            outputTokens: 6836,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 40.95737,
          },
          'claude-haiku-4-5': { inputTokens: 975, outputTokens: 914, costUSD: 0.005545 },
        },
      },
    ]);
    const facts = factsFor(SID, root);
    expect(facts).not.toBeNull();
    // Titles are revised by appending; the newest is the current name.
    expect(facts?.title).toBe('conversation data rendering');
    expect(facts?.cwd).toBe('D:\\PROJECTS\\SAGA');
    expect(facts?.gitBranch).toBe('main');
    expect(facts?.totalCostUSD).toBeCloseTo(8.577185);
    expect(facts?.startedAt).toBe(1788512522929);
    expect(facts?.modelUsage).toHaveLength(2);
    const opus = facts?.modelUsage.find((m) => m.model === 'claude-opus-5[1m]');
    expect(opus?.inputTokens).toBe(8157294);
    expect(opus?.outputTokens).toBe(6836);
    // Absent fields stay null rather than becoming 0.
    const haiku = facts?.modelUsage.find((m) => m.model === 'claude-haiku-4-5');
    expect(haiku?.cacheReadTokens).toBeNull();
  });

  test('an agent-name record also supplies the title', () => {
    const root = fixtureRoot([{ type: 'agent-name', agentName: 'conversation data rendering' }]);
    expect(factsFor(SID, root)?.title).toBe('conversation data rendering');
  });

  test('a torn final line is expected, not fatal', () => {
    // The file is appended to while this reads, so the tail can be half-written.
    const root = fixtureRoot([
      { type: 'ai-title', aiTitle: 'good' },
      { type: 'user', cwd: '/w', gitBranch: 'dev' },
      '{"type":"cost-state","totalCostUSD":1.5,"modelUs',
    ]);
    const facts = factsFor(SID, root);
    expect(facts?.title).toBe('good');
    expect(facts?.cwd).toBe('/w');
    // The torn cost-state contributed nothing rather than throwing.
    expect(facts?.totalCostUSD).toBeNull();
  });

  test('records that are not objects are skipped', () => {
    const root = fixtureRoot(['null', '[1,2,3]', '"a string"', '42', { cwd: '/ok' }]);
    expect(factsFor(SID, root)?.cwd).toBe('/ok');
  });

  test('a transcript with nothing useful yields nulls, not an error', () => {
    const root = fixtureRoot([{ type: 'mode', mode: 'normal' }]);
    const facts = factsFor(SID, root);
    expect(facts).not.toBeNull();
    expect(facts?.title).toBeNull();
    expect(facts?.cwd).toBeNull();
    expect(facts?.modelUsage).toEqual([]);
  });

  test('a nonexistent path returns null instead of throwing', () => {
    expect(readTranscript(join(tmpdir(), 'saga-nope', 'x.jsonl'), SID)).toBeNull();
  });
});

describe('enrichSessions', () => {
  /** Minimal in-memory stand-in for the store's Driver surface. */
  function fakeDb(rows: Array<{ session_id: string; client_session_id: string }>) {
    const updates: Array<Array<string | number | null>> = [];
    return {
      updates,
      db: {
        prepare<Row>(sql: string) {
          return {
            all: () => (sql.includes('SELECT') ? (rows as unknown as Row[]) : []),
            run: (...params: Array<string | number | null>) => {
              updates.push(params);
              return { changes: 1 };
            },
          };
        },
      },
    };
  }

  test('fills only client-declared rows, passing facts through to the update', () => {
    const root = fixtureRoot([
      { type: 'ai-title', aiTitle: 'named run' },
      { type: 'user', cwd: 'D:\\PROJECTS\\SAGA', gitBranch: 'main' },
    ]);
    const { db, updates } = fakeDb([{ session_id: `ses_${SID}`, client_session_id: SID }]);
    const res = enrichSessions(db, { root });
    expect(res.candidates).toBe(1);
    expect(res.enriched).toBe(1);
    expect(res.updated).toBe(1);
    expect(updates[0]).toEqual(['named run', 'D:\\PROJECTS\\SAGA', 'main', `ses_${SID}`]);
  });

  test('a session with no transcript is left untouched', () => {
    const root = fixtureRoot([{ cwd: '/x' }]);
    const other = '11111111-2222-3333-4444-555555555555';
    const { db, updates } = fakeDb([{ session_id: `ses_${other}`, client_session_id: other }]);
    const res = enrichSessions(db, { root });
    expect(res.candidates).toBe(1);
    expect(res.enriched).toBe(0);
    expect(updates).toHaveLength(0);
  });

  test('a pre-migration schema is a no-op, not a crash', () => {
    const throwing = {
      prepare<Row>(_sql: string) {
        return {
          all: (): Row[] => {
            throw new Error('no such column: client_session_id');
          },
          run: () => ({ changes: 0 }),
        };
      },
    };
    expect(enrichSessions(throwing)).toEqual({ candidates: 0, enriched: 0, updated: 0 });
  });
});

/**
 * The COALESCE asymmetry is the whole design of the write, so it is verified
 * against real SQLite rather than a hand-rolled fake — a fake that never runs
 * the statement cannot tell a refresh from an overwrite.
 */
describe('enrichSessions against real SQLite', () => {
  const DDL = `CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    client_name TEXT,
    workspace TEXT,
    client_session_id TEXT,
    session_id_source TEXT NOT NULL DEFAULT 'inferred',
    title TEXT,
    cwd TEXT,
    git_branch TEXT
  ) STRICT, WITHOUT ROWID`;

  const NOW = 1_788_600_000_000;

  function open() {
    const raw = new Database(':memory:');
    raw.run(DDL);
    const db = {
      prepare<Row>(sql: string) {
        const stmt = raw.query(sql);
        return {
          all: (...p: Array<string | number | null>) => stmt.all(...(p as never[])) as Row[],
          run: (...p: Array<string | number | null>) => ({
            changes: stmt.run(...(p as never[])).changes,
          }),
        };
      },
    };
    const seed = (row: {
      lastActivityAt: number;
      title?: string | null;
      cwd?: string | null;
      gitBranch?: string | null;
      clientSessionId?: string | null;
    }) => {
      raw.run(
        `INSERT INTO sessions (session_id, started_at, last_activity_at, client_session_id,
                               session_id_source, title, cwd, git_branch)
         VALUES (?, ?, ?, ?, 'client-declared', ?, ?, ?)`,
        [
          `ses_${row.clientSessionId ?? SID}`,
          NOW - 3_600_000,
          row.lastActivityAt,
          row.clientSessionId ?? SID,
          row.title ?? null,
          row.cwd ?? null,
          row.gitBranch ?? null,
        ] as never[],
      );
    };
    const read = (id = `ses_${SID}`) =>
      raw.query('SELECT title, cwd, git_branch FROM sessions WHERE session_id = ?').get(id) as {
        title: string | null;
        cwd: string | null;
        git_branch: string | null;
      };
    return { db, seed, read };
  }

  test('the title refreshes; cwd and branch are never overwritten', () => {
    // Claude Code renames a conversation as it develops, so the transcript's
    // latest title must win. A working directory is a settled fact and must not
    // be rewritten by a later read.
    const root = fixtureRoot([
      { type: 'ai-title', aiTitle: 'Conversation storage and differentiation' },
      { type: 'user', cwd: 'D:\\PROJECTS\\SAGA', gitBranch: 'main' },
      { type: 'ai-title', aiTitle: 'conversation data rendering' },
    ]);
    const { db, seed, read } = open();
    seed({
      lastActivityAt: NOW,
      title: 'an older name',
      cwd: 'C:\\already-known',
      gitBranch: 'already-known',
    });
    const res = enrichSessions(db, { root, now: NOW });
    expect(res.enriched).toBe(1);
    const row = read();
    expect(row.title).toBe('conversation data rendering');
    expect(row.cwd).toBe('C:\\already-known');
    expect(row.git_branch).toBe('already-known');
  });

  test('a transcript with no title keeps the stored one rather than blanking it', () => {
    const root = fixtureRoot([{ type: 'user', cwd: '/w', gitBranch: 'dev' }]);
    const { db, seed, read } = open();
    seed({ lastActivityAt: NOW, title: 'keep me' });
    enrichSessions(db, { root, now: NOW });
    const row = read();
    expect(row.title).toBe('keep me');
    // The gaps still get filled.
    expect(row.cwd).toBe('/w');
    expect(row.git_branch).toBe('dev');
  });

  test('a long-finished session with every column set is not re-read', () => {
    const root = fixtureRoot([{ type: 'ai-title', aiTitle: 'newer name' }]);
    const { db, seed, read } = open();
    seed({
      lastActivityAt: NOW - 48 * 3_600_000, // outside the refresh window
      title: 'settled',
      cwd: '/w',
      gitBranch: 'main',
    });
    const res = enrichSessions(db, { root, now: NOW });
    expect(res.candidates).toBe(0);
    expect(read().title).toBe('settled');
  });

  test('a recently active session is re-read even with every column set', () => {
    const root = fixtureRoot([{ type: 'ai-title', aiTitle: 'newer name' }]);
    const { db, seed, read } = open();
    seed({ lastActivityAt: NOW - 60_000, title: 'stale', cwd: '/w', gitBranch: 'main' });
    const res = enrichSessions(db, { root, now: NOW });
    expect(res.candidates).toBe(1);
    expect(read().title).toBe('newer name');
  });

  test('an inferred session with no client id is never a candidate', () => {
    const root = fixtureRoot([{ type: 'ai-title', aiTitle: 'x' }]);
    const { db } = open();
    // client_session_id NULL: there is no transcript to key on.
    seed_inferred(db);
    expect(enrichSessions(db, { root, now: NOW }).candidates).toBe(0);
  });

  function seed_inferred(db: { prepare: (sql: string) => { run: (...p: never[]) => unknown } }) {
    db.prepare(
      `INSERT INTO sessions (session_id, started_at, last_activity_at, client_session_id, session_id_source)
       VALUES ('ses_inferred', 1, 2, NULL, 'inferred')`,
    ).run();
  }
});
