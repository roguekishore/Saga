import type { NormalizedRequest } from '@saga/contracts';

/**
 * How a session boundary was decided. Only two answers, and the UI must be
 * able to tell them apart — one is evidence, the other is a guess.
 *
 * - `client-declared`: the client stated its own session id on the wire
 *   (Claude Code's `metadata.user_id.session_id`). Ground truth.
 * - `inferred`: SAGA guessed from client + workspace/prompt shape and idle
 *   time. Labeled inferred everywhere it surfaces.
 */
export type SessionIdSource = 'client-declared' | 'inferred';

export interface SessionAssignment {
  sessionId: string;
  source: SessionIdSource;
  /** The raw client-stated id, when there was one. Keys transcript lookup. */
  clientSessionId: string | null;
}

/**
 * Session correlation. Two paths, and which one ran is recorded per request.
 *
 * When the client states a session id, that IS the session — deterministically
 * mapped to `ses_<uuid>`, with no idle split and no fingerprint involvement.
 * Being derived rather than minted makes it restart-safe: the same
 * conversation keeps one session row across collector restarts, and a session
 * cannot be split by a model switch mid-conversation.
 *
 * Only when nothing on the wire says "session" does the heuristic run: client
 * plus workspace (or, failing that, the system-prompt fingerprint), split on
 * 30 minutes of silence. That path is a guess and is labeled one.
 *
 * The fingerprint deliberately does NOT key a client-declared session. It was
 * doing so before, which shattered one conversation into a session per model
 * and per subagent — the fingerprint's real job is separating AGENTS inside a
 * session (see AgentCorrelator), not bounding the session itself.
 */
export class SessionCorrelator {
  private readonly idleMs: number;
  private readonly active = new Map<string, { sessionId: string; lastTs: number }>();
  private readonly makeId: () => string;

  constructor(makeId: () => string, idleMs = 30 * 60 * 1000) {
    this.makeId = makeId;
    this.idleMs = idleMs;
  }

  assign(input: {
    clientName: string | null;
    workspace: string | null;
    systemFingerprint: string;
    ts: number;
    /** Wire-stated session id, when the client sent one. */
    clientSessionId?: string | null;
  }): SessionAssignment {
    if (input.clientSessionId) {
      return {
        sessionId: `ses_${input.clientSessionId}`,
        source: 'client-declared',
        clientSessionId: input.clientSessionId,
      };
    }

    const key = input.workspace
      ? `${input.clientName ?? '?'}|ws:${input.workspace}`
      : `${input.clientName ?? '?'}|fp:${input.systemFingerprint}`;
    const cur = this.active.get(key);
    if (cur && input.ts - cur.lastTs <= this.idleMs) {
      cur.lastTs = input.ts;
      return { sessionId: cur.sessionId, source: 'inferred', clientSessionId: null };
    }
    const sessionId = `ses_${this.makeId()}`;
    this.active.set(key, { sessionId, lastTs: input.ts });
    // Unbounded otherwise: one entry per distinct client+prompt shape, and
    // idle entries are never revisited once their conversation ends.
    if (this.active.size > 500) {
      for (const [k, v] of this.active) {
        if (input.ts - v.lastTs > this.idleMs) this.active.delete(k);
      }
    }
    return { sessionId, source: 'inferred', clientSessionId: null };
  }
}

/** First ~80 chars of the client's user-agent, or a named client header. */
export function extractClientName(headers: Record<string, string>): string | null {
  const explicit = headers['x-app'] ?? headers['x-client-name'];
  if (explicit) return explicit.slice(0, 80);
  const ua = headers['user-agent'];
  return ua ? ua.slice(0, 80) : null;
}

const WORKSPACE_PATTERNS = [
  /primary working directory[:\s]+([^\s\n"'`]+)/i,
  /working directory[:\s]+([^\s\n"'`]+)/i,
  /\bcwd[:\s=]+([^\s\n"'`]+)/i,
];

/**
 * How far into a system block to look for a workspace path. Claude Code states
 * its working directory ~4.8k chars in (measured: index 4759 of a 10.1k block,
 * 2026-09-04), so the previous 4k cap could never match it and every session
 * landed with a null workspace. Kept as a cap rather than scanning unbounded
 * text, sized well clear of where clients actually put it.
 */
const WORKSPACE_SCAN_LIMIT = 64_000;

/**
 * Workspace path sniffed from system-prompt text (Claude Code states its
 * working directory there). Heuristic → the session row it lands on is
 * labeled inferred in the UI.
 */
export function extractWorkspace(req: NormalizedRequest): string | null {
  for (const sys of req.system) {
    for (const b of sys.blocks) {
      if (b.type !== 'text') continue;
      const head = b.text.slice(0, WORKSPACE_SCAN_LIMIT);
      for (const re of WORKSPACE_PATTERNS) {
        const m = head.match(re);
        if (m?.[1]) return m[1];
      }
    }
  }
  return null;
}

/** Stable fingerprint of the system prompt, for AGENT grouping in a session. */
export function systemFingerprint(req: NormalizedRequest): string {
  const first = req.system[0]?.blocks.find((b) => b.type === 'text');
  const text = first && first.type === 'text' ? first.text.slice(0, 800) : '(none)';
  const h = new Bun.CryptoHasher('sha256');
  h.update(text);
  return h.digest('hex').slice(0, 16);
}
