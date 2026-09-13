import {
  type ClaimSource,
  classifyBlocks,
  type Door,
  type NormalizedRequest,
  type TurnBoundaryKind,
} from '@saga/contracts';

/**
 * Turn grouping — the rung the whole hierarchy rests on.
 *
 * One human-typed message is NOT one model call. It opens an agentic loop: the
 * model calls a tool, the harness runs it and feeds the result back, and the
 * loop repeats until the model answers with no tool call. A small task is ~4
 * requests, a large one 30+, and every request re-ships the entire growing
 * conversation because the model remembers nothing on its own.
 *
 * So a turn is the unit a human would recognize as "the thing I asked for":
 * a human message opens one, every round-trip folds under it, the next human
 * message opens the next.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP: C0 created this file and implements `TurnCorrelator` (state, which
 * the capture call site needs). C3 implements `classifyTurn` (the per-harness
 * heuristic). The split is deliberate: the correlator is a call-site concern and
 * mechanical; the classifier is where the harness knowledge lives.
 *
 * C3 MUST NOT change `TurnCorrelator`'s signature — `proxy.ts` calls it.
 */

export type TurnBoundarySource = ClaimSource;
export type { TurnBoundaryKind };

export interface TurnClassification {
  kind: TurnBoundaryKind;
  source: TurnBoundarySource;
  /** Harness-declared turn id where the wire carries one (Codex). Null otherwise. */
  harnessTurnId: string | null;
  /** Markers that drove the decision — for UI honesty and debugging. */
  evidence: string[];
}

/**
 * Is this request a fresh human instruction, or another round-trip of a loop an
 * earlier instruction started?
 *
 * Implemented. The three rules below are the invariants this function maintains,
 * not background reading — a change that breaks one is a regression even if every
 * test still passes, because each protects a distinction the UI depends on:
 *
 * 1. PREFER EVIDENCE. Codex DECLARES `client_metadata.turn_id`, so grouping is
 *    exact for that harness — return `source: 'harness-declared'` and the id.
 *    Claude Code and Gemini declare nothing, so those are `'inferred'`. Never
 *    override a declared boundary with the heuristic, and never collapse the two
 *    paths into one "simpler" inferred path.
 *
 * 2. THE ROLE-`user` TRAP. "Last message has role `user` → human turn" is WRONG
 *    on both Codex and Gemini: the pushed context block is ALSO a `role:"user"`
 *    item. Discriminate on markers first, role second — Codex
 *    `<user_instructions>`/`<environment_context>`, Gemini `<session_context>`
 *    (always history item 0 at a stable position, so position alone identifies
 *    it there).
 *
 * 3. CLAUDE CODE IS STRUCTURAL, NOT A MARKER HUNT. A tool-result round-trip's
 *    final message consists SOLELY of `tool_result` blocks; a human turn's does
 *    not. `shared.ts` already computes exactly this as `toolOnly`. That is real
 *    payload structure — but it is still SAGA deriving it rather than the harness
 *    stating it, so `source` stays `'inferred'`. Do not promote it.
 *    Compaction writes a distinct record type and must NOT open a turn: doing so
 *    would split one instruction's loop in half.
 */
export function classifyTurn(input: {
  request: NormalizedRequest;
  headers: Record<string, string>;
  adapterId: string;
  door: Door;
  /**
   * The call's role, already classified. A `utility` call is one of Claude
   * Code's own internal helpers (titling, compaction, a quota probe) — it is
   * traffic ABOUT the conversation, never a human instruction in it, so it must
   * never open a turn.
   */
  callRole?: 'main' | 'subagent' | 'utility' | 'unknown';
}): TurnClassification {
  const { request, adapterId, callRole } = input;
  const injections = request.injections ?? [];

  // ---- Codex: harness-declared turn id ------------------------------------
  // Codex puts turn_id in client_metadata (surfaced by C2 via harnessIdentity).
  // When present it is wire evidence — never override with a heuristic.
  if (adapterId === 'codex-responses') {
    const turnId = request.harnessIdentity?.turnId ?? null;
    if (turnId) {
      // Discriminate kind by context markers.
      // user_instructions → genuine human turn; environment_context:diff or
      // nothing recognizable → tool result continuation.
      const injTypes = injections.map((inj) => inj.type);
      const hasUserInstructions = injTypes.includes('user_instructions');
      const kind: TurnBoundaryKind = hasUserInstructions ? 'human_turn' : 'tool_continuation';
      return {
        kind,
        source: 'harness-declared',
        harnessTurnId: turnId,
        evidence: [
          'codex.client_metadata.turn_id',
          hasUserInstructions ? 'injection:user_instructions' : 'no-user-instructions-injection',
        ],
      };
    }
    // No turn id in this codex request — honest unknown.
    return {
      kind: 'unknown',
      source: 'inferred',
      harnessTurnId: null,
      evidence: ['codex-no-turn-id'],
    };
  }

  // ---- Claude Code: structural discriminator ------------------------------
  // Compaction writes a distinct record type — do not open a turn for it.
  // Then: tool-result-only final message → continuation; anything else → human.
  if (adapterId === 'anthropic') {
    // Compaction check: injection tag is the primary signal. The spec also
    // calls out message_count=1 with a single large system block as a secondary
    // marker, but the injection tag is definitive when present.
    const hasCompactionTag = injections.some((inj) => inj.type === 'compaction');
    if (hasCompactionTag) {
      return {
        kind: 'tool_continuation',
        source: 'inferred',
        harnessTurnId: null,
        evidence: ['compaction-detected'],
      };
    }

    const lastMsg = request.messages[request.messages.length - 1];
    if (!lastMsg) {
      return {
        kind: 'unknown',
        source: 'inferred',
        harnessTurnId: null,
        evidence: ['no-messages'],
      };
    }

    // The adapter sets contextSource:'tool' exactly when all blocks are
    // tool_result (structural, not a guess). Check both: the contextSource for
    // the already-normalized message, and the blocks directly for robustness.
    const toolOnly =
      lastMsg.contextSource === 'tool' ||
      (lastMsg.blocks.length > 0 && lastMsg.blocks.every((b) => b.type === 'tool_result'));

    if (toolOnly) {
      return {
        kind: 'tool_continuation',
        source: 'inferred',
        harnessTurnId: null,
        evidence: ['final-message-tool-only'],
      };
    }

    // A utility call is the harness talking about the conversation, not a human
    // talking in it. Measured: Sonnet-5 titling calls each opened a turn of
    // their own, so the session view grew a card the user never typed.
    if (callRole === 'utility') {
      return {
        kind: 'tool_continuation',
        source: 'inferred',
        harnessTurnId: null,
        evidence: ['call-role-utility'],
      };
    }

    // "Not a tool result" is NOT the same as "the human typed something", and
    // treating them as equivalent is what filled the session view with cards
    // nobody wrote. Claude Code splits its own injections into separate text
    // blocks, so the honest test is whether ANY block of the final user message
    // is unmarked human prose.
    //
    // Measured on the live corpus (session ses_6dfad479): 5 of 9 turns were
    // opened by harness-only requests — the safety-grader prompt (a block
    // opening `</transcript>` followed by grading instructions) and the
    // auto-mode reminder. Both carry no human prose at all.
    const ctxs = classifyBlocks(lastMsg.blocks, lastMsg.role);
    const hasHumanProse = ctxs.some((c, i) => {
      const b = lastMsg.blocks[i];
      return c.kind === 'user-prose' && b?.type === 'text' && b.text.trim().length > 0;
    });

    if (!hasHumanProse) {
      return {
        kind: 'tool_continuation',
        source: 'inferred',
        harnessTurnId: null,
        evidence: ['final-message-harness-only'],
      };
    }

    return {
      kind: 'human_turn',
      source: 'inferred',
      harnessTurnId: null,
      evidence: ['final-message-has-user-prose'],
    };
  }

  // ---- Gemini: position-based session_context + final-message role --------
  // session_context always appears as the first injection (history item 0);
  // its presence means this is a context push, not a new human instruction.
  // "Last message role user" alone is NOT sufficient — the pushed context block
  // is also role:user. Discriminate on position first, then on block content.
  if (adapterId === 'gemini') {
    const firstInjIsSessionCtx = injections.length > 0 && injections[0]?.type === 'session_context';
    if (firstInjIsSessionCtx) {
      return {
        kind: 'tool_continuation',
        source: 'inferred',
        harnessTurnId: null,
        evidence: ['gemini-session-context-position-0'],
      };
    }

    const lastMsg = request.messages[request.messages.length - 1];
    if (lastMsg?.role === 'user') {
      // functionResponse parts map to tool_result blocks after normalization.
      const allFunctionResponse =
        lastMsg.blocks.length > 0 && lastMsg.blocks.every((b) => b.type === 'tool_result');
      if (allFunctionResponse) {
        return {
          kind: 'tool_continuation',
          source: 'inferred',
          harnessTurnId: null,
          evidence: ['gemini-last-message-function-response'],
        };
      }
      return {
        kind: 'human_turn',
        source: 'inferred',
        harnessTurnId: null,
        evidence: ['gemini-last-message-user-non-tool'],
      };
    }

    return {
      kind: 'unknown',
      source: 'inferred',
      harnessTurnId: null,
      evidence: ['gemini-no-user-final-message'],
    };
  }

  // ---- Fallback -----------------------------------------------------------
  return {
    kind: 'unknown',
    source: 'inferred',
    harnessTurnId: null,
    evidence: [`unknown-adapter:${adapterId}`],
  };
}

export interface TurnAssignment {
  turnId: string;
  /** Ordinal within the session. */
  seq: number;
  /** True when this request opened the turn. */
  opened: boolean;
  /**
   * True when the turn was opened by a continuation with no open turn — SAGA
   * restarted mid-loop, or capture began mid-conversation. The turn is genuinely
   * incomplete and the UI must be able to say so.
   */
  partial: boolean;
}

interface OpenTurn {
  turnId: string;
  seq: number;
  lastTs: number;
  /** Set only for harness-declared turns, which key directly. */
  harnessTurnId: string | null;
}

/**
 * Assigns requests to turns. Stateful, because `classifyTurn` answers "is this a
 * human turn?" but cannot know WHICH turn is currently open for a session —
 * that requires memory across requests.
 *
 * Modeled on `SessionCorrelator`/`AgentCorrelator`, including their bounded-map
 * hygiene: one entry per session, never revisited once a conversation ends, so
 * without pruning the map grows for the life of the process.
 */
export class TurnCorrelator {
  private readonly open = new Map<string, OpenTurn>();
  private readonly seqBySession = new Map<string, number>();
  private readonly makeId: () => string;
  private readonly idleMs: number;

  constructor(makeId: () => string, idleMs = 30 * 60 * 1000) {
    this.makeId = makeId;
    this.idleMs = idleMs;
  }

  assign(input: {
    sessionId: string;
    classification: TurnClassification;
    ts: number;
  }): TurnAssignment {
    const { sessionId, classification: c, ts } = input;
    const cur = this.open.get(sessionId);

    // A declared turn id keys the turn directly — no idle window, no heuristic.
    // The idle window only ever applies to inferred boundaries.
    if (c.harnessTurnId) {
      if (cur && cur.harnessTurnId === c.harnessTurnId) {
        cur.lastTs = ts;
        return { turnId: cur.turnId, seq: cur.seq, opened: false, partial: false };
      }
      return this.openTurn(sessionId, ts, c.harnessTurnId, false);
    }

    if (c.kind === 'human_turn' || !cur) {
      // No open turn and this is a continuation: capture began mid-loop. Open a
      // turn marked partial rather than silently inventing a human turn — an
      // honest partial turn beats a fabricated complete one.
      const partial = c.kind !== 'human_turn';
      return this.openTurn(sessionId, ts, null, partial);
    }

    // Idle split is a backstop for the inferred path: a "continuation" arriving
    // long after the loop went quiet is far more likely a new instruction whose
    // boundary the heuristic missed than a round-trip resumed after 30 minutes.
    if (ts - cur.lastTs > this.idleMs) {
      return this.openTurn(sessionId, ts, null, true);
    }

    cur.lastTs = ts;
    return { turnId: cur.turnId, seq: cur.seq, opened: false, partial: false };
  }

  private openTurn(
    sessionId: string,
    ts: number,
    harnessTurnId: string | null,
    partial: boolean,
  ): TurnAssignment {
    const seq = (this.seqBySession.get(sessionId) ?? -1) + 1;
    this.seqBySession.set(sessionId, seq);
    const turnId = `turn_${this.makeId()}`;
    this.open.set(sessionId, { turnId, seq, lastTs: ts, harnessTurnId });
    this.prune(ts);
    return { turnId, seq, opened: true, partial };
  }

  /** Bounded like the sibling correlators: idle sessions are never revisited. */
  private prune(now: number): void {
    if (this.open.size <= 500) return;
    for (const [k, v] of this.open) {
      if (now - v.lastTs > this.idleMs) {
        this.open.delete(k);
        this.seqBySession.delete(k);
      }
    }
  }
}
