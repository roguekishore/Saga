import { fileURLToPath } from 'node:url';
import type { SqlResult } from '@saga/contracts';

/**
 * The read-only SQL endpoint's brain. This is a deliberate injection surface;
 * the guards ARE the feature, layered:
 *
 *   1. its own READ-ONLY connection inside a CHILD PROCESS — the wall that
 *      actually holds, and the only way to preempt a synchronous engine;
 *   2. SELECT/WITH-only, single statement — friendly errors before the wall;
 *   3. hard row cap;
 *   4. wall-clock timeout enforced by KILLING the child.
 *
 * A child process rather than a Worker on purpose: workers do not survive
 * `bun build --compile` reliably, and the packaged Windows collector is a
 * compiled binary that re-spawns itself with `--saga-sql-worker`.
 */

export const SQL_ROW_CAP = 1000;
export const SQL_TIMEOUT_MS = 2500;

const FORBIDDEN_HEAD =
  /^\s*(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|pragma|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

export function validateSql(raw: string): { ok: true; sql: string } | { ok: false; error: string } {
  // strip comments before shape checks
  const noComments = raw
    .replaceAll(/--[^\n]*/g, ' ')
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!noComments) return { ok: false, error: 'empty statement' };
  if (FORBIDDEN_HEAD.test(noComments)) {
    return { ok: false, error: 'read-only endpoint: only SELECT (or WITH … SELECT) is allowed' };
  }
  if (!/^\s*(select|with)\b/i.test(noComments)) {
    return { ok: false, error: 'statement must start with SELECT or WITH' };
  }
  // single statement: a semicolon may only be trailing
  const semi = noComments.indexOf(';');
  if (semi !== -1 && noComments.slice(semi + 1).trim() !== '') {
    return { ok: false, error: 'one statement per request' };
  }
  return { ok: true, sql: semi === -1 ? noComments : noComments.slice(0, semi) };
}

interface ChildResponse {
  ok: boolean;
  error?: string;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
}

/** Compiled single-file executables mount their modules under $bunfs. */
function isCompiled(): boolean {
  return typeof Bun !== 'undefined' && Bun.main.includes('$bunfs');
}

function childCommand(dbPath: string): string[] {
  if (isCompiled()) {
    // The collector binary short-circuits into runSqlChild on this flag.
    return [process.execPath, '--saga-sql-worker', dbPath, String(SQL_ROW_CAP)];
  }
  const childScript = fileURLToPath(new URL('./sql-child.ts', import.meta.url));
  return [process.execPath, childScript, '--saga-sql-worker', dbPath, String(SQL_ROW_CAP)];
}

export class SqlExecutor {
  private busy = false;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  get available(): boolean {
    return this.dbPath !== ':memory:';
  }

  async run(
    rawSql: string,
  ): Promise<{ ok: true; result: SqlResult } | { ok: false; error: string; status: number }> {
    if (!this.available) {
      return { ok: false, error: 'SQL endpoint requires a file-backed database', status: 501 };
    }
    const v = validateSql(rawSql);
    if (!v.ok) return { ok: false, error: v.error, status: 400 };
    if (this.busy) {
      return {
        ok: false,
        error: 'another query is running; the endpoint is single-flight',
        status: 429,
      };
    }
    this.busy = true;
    try {
      const proc = Bun.spawn({
        cmd: childCommand(this.dbPath),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      proc.stdin.write(v.sql);
      await proc.stdin.end();

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, SQL_TIMEOUT_MS);

      const raw = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);

      if (timedOut) {
        return {
          ok: false,
          error: `query exceeded ${SQL_TIMEOUT_MS}ms and was terminated`,
          status: 408,
        };
      }

      let outcome: ChildResponse;
      try {
        outcome = JSON.parse(raw) as ChildResponse;
      } catch {
        return { ok: false, error: 'sql child produced no result', status: 500 };
      }
      if (!outcome.ok) return { ok: false, error: outcome.error ?? 'query failed', status: 400 };
      return {
        ok: true,
        result: {
          columns: outcome.columns ?? [],
          rows: outcome.rows ?? [],
          rowCount: outcome.rowCount ?? 0,
          truncated: outcome.truncated ?? false,
          elapsedMs: outcome.elapsedMs ?? 0,
        },
      };
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    // Per-query children; nothing long-lived to tear down.
  }
}
