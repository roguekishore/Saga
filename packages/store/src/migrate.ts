import type { Driver } from './driver';

/**
 * Migration runner. SQLite cannot `ALTER TABLE ... MODIFY COLUMN`, so every
 * schema change that touches a column is create-copy-drop-rename from the
 * first migration on — retrofitting that discipline later is the trap.
 *
 * Migrations are ordered lists of single statements (never multi-statement
 * strings — splitting SQL by semicolon breaks on triggers, and drivers vary
 * in multi-statement support).
 */
export interface Migration {
  id: number;
  name: string;
  statements: string[];
}

export interface MigrationResult {
  applied: Array<{ id: number; name: string }>;
  alreadyAt: number;
}

export function runMigrations(db: Driver, migrations: Migration[]): MigrationResult {
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    if (m.id !== i + 1) {
      throw new Error(`migrations must be contiguous from 1; found id ${m.id} at position ${i}`);
    }
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT`,
  );

  const appliedRows = db
    .prepare<{ id: number; name: string }>('SELECT id, name FROM _migrations ORDER BY id')
    .all();

  for (const row of appliedRows) {
    const m = sorted[row.id - 1];
    if (!m || m.name !== row.name) {
      throw new Error(
        `migration history diverged: db has #${row.id} "${row.name}", code has "${m?.name ?? 'nothing'}"`,
      );
    }
  }

  const applied: Array<{ id: number; name: string }> = [];
  const insert = db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)');

  for (const m of sorted.slice(appliedRows.length)) {
    db.transaction(() => {
      for (const stmt of m.statements) db.exec(stmt);
      insert.run(m.id, m.name, Date.now());
    });
    applied.push({ id: m.id, name: m.name });
  }

  return { applied, alreadyAt: appliedRows.length };
}
