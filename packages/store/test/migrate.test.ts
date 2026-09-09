import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../src/driver';
import { type Migration, runMigrations } from '../src/migrate';

const m1: Migration = {
  id: 1,
  name: 'init',
  statements: ['CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT'],
};
const m2: Migration = {
  id: 2,
  name: 'add-b',
  statements: ['CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT'],
};

describe('migration runner', () => {
  test('applies in order and is idempotent on re-run', () => {
    const db = openDatabase(':memory:');
    const first = runMigrations(db, [m1, m2]);
    expect(first.applied.map((a) => a.id)).toEqual([1, 2]);
    const again = runMigrations(db, [m1, m2]);
    expect(again.applied).toEqual([]);
    expect(again.alreadyAt).toBe(2);
    db.close();
  });

  test('rejects non-contiguous ids', () => {
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, [m1, { ...m2, id: 5 }])).toThrow(/contiguous/);
    db.close();
  });

  test('rejects diverged history', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, [m1]);
    expect(() => runMigrations(db, [{ ...m1, name: 'different' }, m2])).toThrow(/diverged/);
    db.close();
  });

  test('a failing migration rolls back atomically', () => {
    const db = openDatabase(':memory:');
    const bad: Migration = {
      id: 1,
      name: 'bad',
      statements: [
        'CREATE TABLE ok_table (id INTEGER PRIMARY KEY) STRICT',
        'CREATE TABLE syntax error here',
      ],
    };
    expect(() => runMigrations(db, [bad])).toThrow();
    // Neither the table nor the migration row survived.
    const tables = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).not.toContain('ok_table');
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM _migrations').get()?.n).toBe(0);
    db.close();
  });

  test('create-copy-drop-rename column change works end to end', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, [m1]);
    db.prepare('INSERT INTO a (v) VALUES (?)').run('keep-me');
    // SQLite cannot MODIFY COLUMN: the only honest path is a new table.
    const widen: Migration = {
      id: 2,
      name: 'widen-a-v',
      statements: [
        'CREATE TABLE a_new (id INTEGER PRIMARY KEY, v TEXT NOT NULL, extra TEXT) STRICT',
        'INSERT INTO a_new (id, v) SELECT id, v FROM a',
        'DROP TABLE a',
        'ALTER TABLE a_new RENAME TO a',
      ],
    };
    runMigrations(db, [m1, widen]);
    const row = db.prepare<{ v: string; extra: string | null }>('SELECT v, extra FROM a').get();
    expect(row?.v).toBe('keep-me');
    expect(row?.extra).toBeNull();
    db.close();
  });
});
