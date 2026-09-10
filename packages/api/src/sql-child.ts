import { Database } from 'bun:sqlite';

/**
 * SQL executor child process. One process per query, its OWN read-only
 * connection, killed by the parent on timeout — bun:sqlite is synchronous,
 * so isolation has to be a process boundary, and a child (unlike a Worker)
 * survives `bun build --compile` with zero bundler coupling: the compiled
 * collector simply re-spawns itself with `--saga-sql-worker`.
 *
 * Protocol: argv `--saga-sql-worker <dbPath> <rowCap>`, SQL arrives on
 * stdin, exactly one JSON line leaves on stdout.
 */
export async function runSqlChild(argv: string[]): Promise<void> {
  const flagIdx = argv.indexOf('--saga-sql-worker');
  const dbPath = argv[flagIdx + 1];
  const rowCap = Number(argv[flagIdx + 2] ?? 1000);
  const t0 = performance.now();
  try {
    const sql = await new Response(Bun.stdin.stream()).text();
    if (!dbPath) throw new Error('missing db path');
    const db = new Database(dbPath, { readonly: true });
    try {
      db.run('PRAGMA busy_timeout = 1500');
      const stmt = db.prepare(sql);
      const columns = (stmt.columnNames ?? []) as string[];
      const all = stmt.values() as unknown[][];
      const truncated = all.length > rowCap;
      const rows = truncated ? all.slice(0, rowCap) : all;
      console.log(
        JSON.stringify({
          ok: true,
          columns,
          rows,
          rowCount: rows.length,
          truncated,
          elapsedMs: performance.now() - t0,
        }),
      );
    } finally {
      db.close();
    }
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err) }));
  }
}

if (import.meta.main) {
  await runSqlChild(process.argv);
}
