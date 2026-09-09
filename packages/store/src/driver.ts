/**
 * SQLite driver shim — the ~6 operations SAGA uses, so the engine can swap
 * (`bun:sqlite` today, `node:sqlite` on Node 22+ later) without touching
 * callers. No native compilation of any kind; both engines are built in.
 */

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface Statement<Row = SqlRow> {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Row | null;
  all(...params: SqlValue[]): Row[];
}

export interface Driver {
  readonly path: string;
  prepare<Row = SqlRow>(sql: string): Statement<Row>;
  /** Single-statement execute (DDL etc.). Migrations pass statement lists. */
  exec(sql: string): void;
  pragma(name: string): unknown;
  setPragma(name: string, value: string | number): void;
  /** Synchronous transaction; rolls back if `fn` throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

import { Database } from 'bun:sqlite';

class BunStatement<Row = SqlRow> implements Statement<Row> {
  constructor(private readonly stmt: ReturnType<Database['query']>) {}
  run(...params: SqlValue[]) {
    const r = this.stmt.run(...(params as never[]));
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
  get(...params: SqlValue[]): Row | null {
    return (this.stmt.get(...(params as never[])) as Row | null) ?? null;
  }
  all(...params: SqlValue[]): Row[] {
    return this.stmt.all(...(params as never[])) as Row[];
  }
}

class BunDriver implements Driver {
  private readonly db: Database;
  readonly path: string;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    this.path = path;
    this.db = new Database(path, {
      readonly: opts.readonly ?? false,
      create: !(opts.readonly ?? false),
    });
    // Per-connection, ALWAYS: foreign_keys does not persist (WAL does).
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA busy_timeout = 5000');
    if (!opts.readonly && path !== ':memory:') {
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA synchronous = NORMAL');
    }
  }

  prepare<Row = SqlRow>(sql: string): Statement<Row> {
    return new BunStatement<Row>(this.db.query(sql));
  }

  exec(sql: string): void {
    this.db.run(sql);
  }

  pragma(name: string): unknown {
    const row = this.db.query(`PRAGMA ${name}`).get() as SqlRow | null;
    if (row == null) return null;
    const vals = Object.values(row);
    return vals.length === 1 ? vals[0] : row;
  }

  setPragma(name: string, value: string | number): void {
    this.db.run(`PRAGMA ${name} = ${value}`);
  }

  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped() as T;
  }

  close(): void {
    this.db.close();
  }
}

export function openDatabase(path: string, opts: { readonly?: boolean } = {}): Driver {
  return new BunDriver(path, opts);
}
