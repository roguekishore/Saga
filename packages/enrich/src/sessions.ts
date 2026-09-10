import { defaultProjectsRoot, factsFor, type TranscriptFacts } from './transcript';

/**
 * Applying transcript facts to session rows.
 *
 * Deliberately structural rather than importing the store's `Driver`: this
 * package stays a leaf with no runtime dependency on the store, so enrichment
 * can never end up on the write path by accident.
 */
export interface EnrichStatement<Row = Record<string, unknown>> {
  run(...params: Array<string | number | null>): { changes: number };
  all(...params: Array<string | number | null>): Row[];
}

export interface EnrichDb {
  prepare<Row = Record<string, unknown>>(sql: string): EnrichStatement<Row>;
}

export interface EnrichResult {
  /** Sessions considered this pass. */
  candidates: number;
  /** Sessions a transcript was found and read for. */
  enriched: number;
  /**
   * Rows written. Note SQLite reports a change even when the new values equal
   * the old ones, so this counts writes attempted, not facts that differed.
   */
  updated: number;
}

/** How long after last activity a session's title is still worth re-reading. */
export const DEFAULT_REFRESH_WINDOW_MS = 24 * 3_600_000;

/**
 * Fill `title` / `cwd` / `git_branch` for sessions whose id the client stated.
 *
 * Only client-declared sessions are candidates: an inferred session has no
 * client session id, so there is no transcript to key on.
 *
 * The title REFRESHES; `cwd` and `git_branch` do not. That asymmetry is
 * deliberate. Claude Code revises a conversation's title as the conversation
 * develops — one session here went from "Conversation storage and
 * differentiation" to "conversation data rendering" (observed 2026-09-04) — and
 * the transcript's latest title is the current name, so pinning the first one
 * SAGA happened to see would show a stale name forever. A working directory and
 * a branch, by contrast, are settled facts about the run; first sighting wins
 * and a later null can never blank them.
 *
 * Candidates are therefore anything with a gap to fill, plus anything active
 * recently enough that its title may still be moving. A long-finished session
 * with all three columns set is never re-read.
 *
 * Never throws: enrichment runs beside a live collector and a missing
 * transcript directory is the normal case, not an error.
 */
export function enrichSessions(
  db: EnrichDb,
  opts: { root?: string; limit?: number; refreshWindowMs?: number; now?: number } = {},
): EnrichResult {
  const root = opts.root ?? defaultProjectsRoot();
  const limit = opts.limit ?? 500;
  const window = opts.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const result: EnrichResult = { candidates: 0, enriched: 0, updated: 0 };

  let rows: Array<{ session_id: string; client_session_id: string }>;
  try {
    rows = db
      .prepare<{ session_id: string; client_session_id: string }>(
        `SELECT session_id, client_session_id FROM sessions
          WHERE client_session_id IS NOT NULL
            AND (title IS NULL OR cwd IS NULL OR git_branch IS NULL
                 OR last_activity_at >= ?)
          ORDER BY last_activity_at DESC
          LIMIT ?`,
      )
      .all(now - window, limit);
  } catch {
    return result; // pre-migration schema; nothing to do
  }
  result.candidates = rows.length;

  // `COALESCE(?, title)` refreshes when the transcript has a title and keeps
  // the stored one when it does not; the other two are `COALESCE(col, ?)`,
  // which fills a gap but never overwrites.
  const update = db.prepare(
    `UPDATE sessions SET
       title = COALESCE(?, title),
       cwd = COALESCE(cwd, ?),
       git_branch = COALESCE(git_branch, ?)
     WHERE session_id = ?`,
  );

  for (const row of rows) {
    let facts: TranscriptFacts | null = null;
    try {
      facts = factsFor(row.client_session_id, root);
    } catch {
      continue; // unreadable transcript; leave the row alone
    }
    if (!facts) continue;
    result.enriched++;
    try {
      const r = update.run(facts.title, facts.cwd, facts.gitBranch, row.session_id);
      result.updated += r.changes;
    } catch {
      // a write that fails here costs a null column, nothing more
    }
  }

  return result;
}

/**
 * Run enrichment periodically, returning a stop function.
 *
 * Unlike the store's retention scheduler, the first tick is DEFERRED rather
 * than run inline. Retention's check is one indexed query; an enrichment pass
 * reads whole transcript files (megabytes each) with synchronous I/O, so
 * running it inline would sit between process start and the proxy accepting
 * traffic. Capture comes first — enrichment can be a few seconds late.
 *
 * The interval is generous for the same reason: often enough that a revised
 * title is not stale for long, rare enough that it never competes with capture.
 * A failing tick logs and is otherwise ignored.
 */
export function scheduleEnrichment(
  db: EnrichDb,
  opts: {
    root?: string;
    limit?: number;
    refreshWindowMs?: number;
    everyMs?: number;
    /** Delay before the first pass. Keeps synchronous reads off the boot path. */
    firstDelayMs?: number;
    log?: (level: 'info' | 'error', message: string) => void;
  } = {},
): () => void {
  const everyMs = opts.everyMs ?? 30 * 60_000;
  const firstDelayMs = opts.firstDelayMs ?? 5_000;
  const tick = (): void => {
    try {
      const r = enrichSessions(db, opts);
      if (r.enriched > 0) {
        opts.log?.('info', `enriched ${r.enriched}/${r.candidates} session(s) from transcripts`);
      }
    } catch (err) {
      opts.log?.('error', `scheduled run failed: ${String(err)}`);
    }
  };
  // Both timers are unref'd: enrichment must never be why the process lingers.
  const unref = (t: unknown): void => {
    (t as { unref?: () => void }).unref?.();
  };
  const first = setTimeout(tick, firstDelayMs);
  unref(first);
  const repeat = setInterval(tick, everyMs);
  unref(repeat);
  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}
