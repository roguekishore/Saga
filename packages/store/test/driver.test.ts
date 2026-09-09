import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/driver';

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saga-driver-'));
  dirs.push(dir);
  return join(dir, 'test.db');
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('driver shim', () => {
  test('prepare/run/get/all round-trip', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT');
    const ins = db.prepare('INSERT INTO t (name) VALUES (?)');
    ins.run('a');
    ins.run('b');
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(2);
    expect(db.prepare('SELECT name FROM t ORDER BY id').all()).toEqual([
      { name: 'a' },
      { name: 'b' },
    ]);
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(99)).toBeNull();
    db.close();
  });

  test('foreign_keys is ON per connection', () => {
    const db = openDatabase(tempDb());
    expect(db.pragma('foreign_keys')).toBe(1);
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY) STRICT');
    db.exec(
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES p(id)) STRICT',
    );
    expect(() => db.prepare('INSERT INTO c (pid) VALUES (?)').run(42)).toThrow();
    db.close();
  });

  test('WAL engaged on file databases', () => {
    const db = openDatabase(tempDb());
    expect(String(db.pragma('journal_mode')).toLowerCase()).toBe('wal');
    db.close();
  });

  test('STRICT typing is enforced', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE s (n INTEGER) STRICT');
    expect(() => db.prepare('INSERT INTO s (n) VALUES (?)').run('not-a-number')).toThrow();
    db.close();
  });

  test('transaction rolls back on throw', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) STRICT');
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('kept?');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(0);
    db.close();
  });

  test('blobs round-trip as Uint8Array', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY, body BLOB NOT NULL) STRICT');
    const payload = new Uint8Array([1, 2, 3, 250]);
    db.prepare('INSERT INTO b (body) VALUES (?)').run(payload);
    const row = db.prepare<{ body: Uint8Array }>('SELECT body FROM b').get();
    expect(Array.from(row?.body ?? [])).toEqual([1, 2, 3, 250]);
    db.close();
  });

  test('readonly connections cannot write', () => {
    const path = tempDb();
    const rw = openDatabase(path);
    rw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT');
    rw.close();
    const ro = openDatabase(path, { readonly: true });
    expect(() => ro.exec('INSERT INTO t DEFAULT VALUES')).toThrow();
    ro.close();
  });
});
