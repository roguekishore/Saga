import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDatabase, runMigrations } from '@saga/store';
import { SQL_ROW_CAP, SQL_TIMEOUT_MS, SqlExecutor, validateSql } from '../src/sql';

let dir: string;
let dbPath: string;
let exec: SqlExecutor;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'saga-sql-'));
  dbPath = join(dir, 'sql.db');
  const db = openDatabase(dbPath);
  runMigrations(db, MIGRATIONS);
  db.exec(`INSERT INTO sessions (session_id, started_at, last_activity_at) VALUES ('s1', 1, 2)`);
  db.close();
  exec = new SqlExecutor(dbPath);
});

afterAll(() => {
  exec.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('validateSql (friendly errors in front of the readonly wall)', () => {
  test('SELECT and WITH pass; writes and pragmas are rejected at the head', () => {
    expect(validateSql('SELECT 1').ok).toBe(true);
    expect(validateSql('  with x as (select 1) select * from x').ok).toBe(true);
    for (const bad of [
      'INSERT INTO sessions VALUES (1)',
      'update requests set model = null',
      'DROP TABLE requests',
      'PRAGMA journal_mode=DELETE',
      "ATTACH DATABASE '/tmp/x' AS x",
      'VACUUM',
    ]) {
      expect(validateSql(bad).ok).toBe(false);
    }
  });

  test('multi-statement smuggling is rejected; comments are stripped first', () => {
    expect(validateSql('SELECT 1; DROP TABLE requests').ok).toBe(false);
    expect(validateSql('SELECT 1;   ').ok).toBe(true);
    expect(validateSql('-- sneaky\nDELETE FROM requests').ok).toBe(false);
    expect(validateSql('/* x */ SELECT 2').ok).toBe(true);
  });
});

describe('SqlExecutor (worker + readonly connection + caps)', () => {
  test('plain select works with columns and rows', async () => {
    const r = await exec.run('SELECT session_id, started_at FROM sessions');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.columns).toEqual(['session_id', 'started_at']);
      expect(r.result.rows[0]?.[0]).toBe('s1');
      expect(r.result.truncated).toBe(false);
    }
  });

  test('WITH … INSERT sneaks past the head check and dies on the readonly wall', async () => {
    const r = await exec.run(
      `WITH x AS (SELECT 1) INSERT INTO sessions (session_id, started_at, last_activity_at) SELECT 'evil', 1, 2 FROM x`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain('readonly');
    // and the row is provably absent
    const check = await exec.run(`SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'evil'`);
    expect(check.ok && check.result.rows[0]?.[0]).toBe(0);
  });

  test('row cap truncates honestly', async () => {
    const r = await exec.run(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c LIMIT ${SQL_ROW_CAP + 500}) SELECT x FROM c`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.rowCount).toBe(SQL_ROW_CAP);
      expect(r.result.truncated).toBe(true);
    }
  });

  test('runaway query is terminated at the timeout, endpoint survives', async () => {
    const t0 = performance.now();
    const r = await exec.run(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c`,
    );
    const elapsed = performance.now() - t0;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(408);
    expect(elapsed).toBeGreaterThanOrEqual(SQL_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(SQL_TIMEOUT_MS + 2000);
    // fresh worker serves the next query fine
    const again = await exec.run('SELECT 42 AS v');
    expect(again.ok && again.result.rows[0]?.[0]).toBe(42);
  }, 15_000);

  test('in-memory databases refuse the endpoint honestly', async () => {
    const mem = new SqlExecutor(':memory:');
    const r = await mem.run('SELECT 1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(501);
  });
});
