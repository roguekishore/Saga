import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Local transcript enrichment — read-only, and NOT part of the capture path.
 *
 * Claude Code keeps a JSONL transcript per conversation at
 * `~/.claude/projects/<slug>/<uuid>.jsonl`, where `<uuid>` is exactly the
 * session id the client states on the wire (`metadata.user_id.session_id`).
 * Because SAGA now records that id, it can find the conversation locally and
 * borrow what the wire never carries: the name Claude Code gave the session,
 * its working directory, its git branch, and the client's own accounting.
 *
 * Three rules hold this to the thin-wrapper line:
 *
 * 1. Read-only, and never in the request path. This runs after the fact, so
 *    nothing here can slow or break a proxied call.
 * 2. No gateway coupling. It reads the CLIENT's own files, so it works
 *    whatever sits upstream, and its absence costs nothing but null columns.
 * 3. Metadata only. Titles, paths, branch names and counters — never message
 *    content, never file contents. The transcript holds the whole
 *    conversation; this deliberately reads past it.
 */

/** Facts worth borrowing from one transcript. Everything is nullable. */
export interface TranscriptFacts {
  clientSessionId: string;
  /** Absolute path of the transcript these came from. */
  path: string;
  /**
   * The conversation's name, as Claude Code titled it. Last-write-wins:
   * `ai-title` and `agent-name` records are appended as the title is revised,
   * so the final one is the current name.
   */
  title: string | null;
  /** Working directory the client reported. Exact, not sniffed from a prompt. */
  cwd: string | null;
  gitBranch: string | null;
  /**
   * The CLIENT's own per-model token accounting, from its last `cost-state`
   * record. Better sourced than a gateway estimate — it is what the client
   * itself believes it spent — but still the client's number rather than the
   * provider's, so callers must label it client-reported.
   *
   * `costUSD` is list-price arithmetic. Against a subscription upstream it is
   * NOT what the user is charged and must never be shown as billing.
   */
  modelUsage: Array<{
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    costUSD: number | null;
  }>;
  totalCostUSD: number | null;
  /** Wall-clock start the client recorded, when it recorded one. */
  startedAt: number | null;
}

/**
 * A session id is only ever a uuid, and this is checked BEFORE the value
 * touches a path. The id arrives from the wire, so without this a client could
 * offer `../../../etc/passwd` as its session id and have SAGA read it. The
 * adapter already gates on the same shape; this re-checks instead of trusting
 * it, because the two can drift and only one of them is next to the filesystem.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTranscriptId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Default transcript root. Overridable so tests never read a real home dir. */
export function defaultProjectsRoot(home: string = homedir()): string {
  return join(home, '.claude', 'projects');
}

/**
 * Locate the transcript for a session id.
 *
 * The containing folder is a slug of the working directory, which SAGA does not
 * reliably know in advance — that is one of the things being looked up. So the
 * uuid is the key and the folder is the answer: one shallow directory scan.
 * Null when nothing matches, which is the normal case for any client that is
 * not Claude Code.
 */
export function findTranscript(
  clientSessionId: string,
  root: string = defaultProjectsRoot(),
): string | null {
  if (!isTranscriptId(clientSessionId)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null; // no transcript root on this machine; enrichment is optional
  }
  const rootAbs = resolve(root);
  for (const dir of dirs) {
    const candidate = resolve(join(root, dir, `${clientSessionId}.jsonl`));
    // Defence in depth: the id is uuid-checked above, but a path that escapes
    // the root is never read regardless of how it got here.
    if (!candidate.startsWith(rootAbs + sep)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this project folder
    }
  }
  return null;
}

/**
 * Transcripts run to a few MB. This cap stops a pathological file from being
 * read into memory wholesale; past it, enrichment declines rather than risking
 * the collector's footprint.
 */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Parse one transcript into facts. Malformed lines are skipped rather than
 * fatal: the file is appended to while this reads, so a torn final line is
 * expected, not exceptional.
 */
export function readTranscript(path: string, clientSessionId: string): TranscriptFacts | null {
  let text: string;
  try {
    if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return null;
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const facts: TranscriptFacts = {
    clientSessionId,
    path,
    title: null,
    cwd: null,
    gitBranch: null,
    modelUsage: [],
    totalCostUSD: null,
    startedAt: null,
  };

  let lastCostState: Record<string, unknown> | null = null;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      rec = parsed as Record<string, unknown>;
    } catch {
      continue; // torn or non-JSON line
    }

    // Titles are revised by appending a new record; the last one wins.
    const title = str(rec.aiTitle) ?? str(rec.agentName);
    if (title) facts.title = title.slice(0, 200);
    // cwd/gitBranch ride along on ordinary records; first sighting is enough.
    facts.cwd ??= str(rec.cwd);
    facts.gitBranch ??= str(rec.gitBranch);
    if (rec.type === 'cost-state') lastCostState = rec;
  }

  if (lastCostState) {
    facts.totalCostUSD = num(lastCostState.totalCostUSD);
    facts.startedAt = num(lastCostState.startTime);
    const usage = lastCostState.modelUsage;
    if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
      for (const [model, raw] of Object.entries(usage as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const u = raw as Record<string, unknown>;
        facts.modelUsage.push({
          model,
          inputTokens: num(u.inputTokens),
          outputTokens: num(u.outputTokens),
          cacheReadTokens: num(u.cacheReadInputTokens),
          cacheCreationTokens: num(u.cacheCreationInputTokens),
          costUSD: num(u.costUSD),
        });
      }
    }
  }

  return facts;
}

/** Find and read in one step. Null whenever there is nothing to enrich from. */
export function factsFor(
  clientSessionId: string,
  root: string = defaultProjectsRoot(),
): TranscriptFacts | null {
  const path = findTranscript(clientSessionId, root);
  return path ? readTranscript(path, clientSessionId) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
