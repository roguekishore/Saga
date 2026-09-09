/**
 * Agent correlation — a HEURISTIC, labeled inferred everywhere it surfaces.
 *
 * Signal 1: distinct system-prompt fingerprints inside one session are
 * distinct agents (a Claude Code subagent runs with its own system prompt).
 * Signal 2: if agent B's first request starts while a request from agent A is
 * still in flight in the same session, B is inferred to be A's child — the
 * parent is blocked on the Task tool while the subagent works.
 *
 * Both signals can be wrong (parallel unrelated work, shared prompts). This
 * is a best guess from shape and timing, never wire truth.
 */
export interface AgentAssignment {
  agentId: string;
  parentAgentId: string | null;
  label: string;
}

interface SessionAgents {
  byFingerprint: Map<string, AgentAssignment>;
  inflight: Map<string, { agentId: string; ts: number }>;
  count: number;
}

const LABEL_RE = /you are (?:an? |the )?([a-z][a-z0-9 _/-]{2,42})/i;

const STOPWORDS = new Set(['for', 'of', 'in', 'to', 'that', 'this', 'the', 'with', 'and', 'who']);

export function labelFromSystem(systemHead: string, index: number): string {
  const m = systemHead.match(LABEL_RE);
  if (m?.[1]) {
    const words = m[1].trim().split(/\s+/).slice(0, 4);
    // cut at the first stopword once we have something usable
    const cut = words.findIndex((w, i) => i >= 1 && STOPWORDS.has(w.toLowerCase()));
    const label = (cut === -1 ? words : words.slice(0, cut)).join(' ');
    if (label.length >= 3) return label;
  }
  return index === 0 ? 'main' : `agent-${index}`;
}

export class AgentCorrelator {
  private readonly sessions = new Map<string, SessionAgents>();
  private readonly makeId: () => string;

  constructor(makeId: () => string) {
    this.makeId = makeId;
  }

  assign(input: {
    sessionId: string;
    requestId: string;
    systemFingerprint: string;
    systemHead: string;
    ts: number;
  }): AgentAssignment {
    let s = this.sessions.get(input.sessionId);
    if (!s) {
      s = { byFingerprint: new Map(), inflight: new Map(), count: 0 };
      this.sessions.set(input.sessionId, s);
      // sessions map growth is bounded by eviction below
      if (this.sessions.size > 500) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
    }

    let agent = s.byFingerprint.get(input.systemFingerprint);
    if (!agent) {
      // Newest in-flight request from a DIFFERENT agent is the inferred parent.
      let parent: { agentId: string; ts: number } | null = null;
      for (const inf of s.inflight.values()) {
        if (!parent || inf.ts > parent.ts) parent = inf;
      }
      agent = {
        agentId: `agt_${this.makeId()}`,
        parentAgentId: parent?.agentId ?? null,
        label: labelFromSystem(input.systemHead, s.count),
      };
      s.byFingerprint.set(input.systemFingerprint, agent);
      s.count++;
    }

    s.inflight.set(input.requestId, { agentId: agent.agentId, ts: input.ts });
    return agent;
  }

  finish(sessionId: string, requestId: string): void {
    this.sessions.get(sessionId)?.inflight.delete(requestId);
  }
}
