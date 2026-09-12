import type { CallRole, ClaimSource, Door, NormalizedRequest } from '@saga/contracts';

/**
 * `call_role` — main / subagent / utility.
 *
 * Claude Code fires internal helper calls to smaller models (titling,
 * compaction, recap). On the wire they arrive as ordinary standalone requests,
 * so without this classification they surface as conversations of their own
 * rather than folding into the one that spawned them.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP: C0 created this stub; C3 implements it. `proxy.ts` calls it, so the
 * signature is frozen — C3 fills the body.
 */

export type CallRoleSource = ClaimSource;
export type { CallRole };

export interface CallRoleClassification {
  role: CallRole;
  source: CallRoleSource;
  evidence: string[];
}

/**
 * Implemented. Note that `unknown` is not a stub leftover here: for Gemini it is
 * the permanently correct answer, because the Vertex wire carries nothing that
 * would distinguish these roles. What the classifier rests on:
 *
 * DECLARED, for Codex only. `x-openai-subagent` ∈ {review, compact,
 * memory_consolidation, collab_spawn, custom}: absent → `main`;
 * `compact`/`memory_consolidation` → `utility`; anything else → `subagent`.
 * Source is `'harness-declared'`. C2 surfaces the raw value.
 *
 * FINGERPRINTED, for Claude Code (`source: 'inferred'`):
 *   utility  — no tools AND max_tokens <= 64 AND message_count <= 3
 *   subagent — a smaller model under a session that has already seen a larger
 *              one, WITH tools and a real budget
 *   main     — everything else
 *
 * Both fingerprints are as measured against real traffic (`docs/ws-c/CV-findings.md`,
 * 279 utility calls over 4 sessions), and both CORRECT what the spec originally
 * asserted. Do not "restore" either older rule:
 *
 *  - "tiny prompt" is backwards. Utility payloads are LARGE — mean 217KB, because
 *    a titling call ships the conversation it has to summarize. Sizing on the
 *    prompt would miss nearly all of them; `message_count` is what separates them
 *    (utility sits at 2-3 messages, everything else spans 0-455).
 *  - "a Sonnet request under an Opus session is a subagent" would mislabel 278 of
 *    395 Sonnet calls, because the utility traffic IS Sonnet under Opus sessions.
 *    That is why the tools-and-budget conditions are load-bearing rather than
 *    incidental, and why `sessionModels` alone is never sufficient.
 *
 * "Cheap model" is also relative and deliberately unused: utility ran on Sonnet-5
 * under Opus-5 sessions, while Haiku appeared with no tools and a 32,000 budget,
 * which is not utility at all.
 *
 * NOT INFERRABLE for Gemini. The Vertex wire carries nothing that distinguishes
 * these. Return `'unknown'` rather than guessing; the schema has a slot for it
 * and an honest unknown beats a fabricated role.
 *
 * `evidence` is not decoration — it records WHY, so a reader can check a label
 * instead of trusting it. Populate it even for `unknown`, where the evidence is
 * what you looked for and did not find.
 */
export function classifyCallRole(input: {
  request: NormalizedRequest;
  headers: Record<string, string>;
  adapterId: string;
  door: Door;
  /** Models already seen in this session — drives the Sonnet-under-Opus signal. */
  sessionModels: string[];
}): CallRoleClassification {
  const { request, headers, adapterId, sessionModels } = input;

  // ---- Codex: harness-declared role ---------------------------------------
  // C2 surfaces the raw x-openai-subagent header value. Map it:
  //   absent           → main
  //   compact / memory_consolidation → utility
  //   anything else    → subagent
  if (adapterId === 'codex-responses') {
    const raw = headers['x-openai-subagent'] ?? null;
    if (!raw) {
      return {
        role: 'main',
        source: 'harness-declared',
        evidence: ['x-openai-subagent:absent'],
      };
    }
    if (raw === 'compact' || raw === 'memory_consolidation') {
      return {
        role: 'utility',
        source: 'harness-declared',
        evidence: [`x-openai-subagent:${raw}`],
      };
    }
    return {
      role: 'subagent',
      source: 'harness-declared',
      evidence: [`x-openai-subagent:${raw}`],
    };
  }

  // ---- Claude Code: fingerprint-based classification ----------------------
  // CV-findings corrected both signals:
  //
  // UTILITY fingerprint (from CV, not the spec):
  //   tools=[] AND max_tokens<=64 AND message_count<=3
  //   Payloads are LARGE (~217KB); do NOT use payload size.
  //
  // SUBAGENT (refined CV form):
  //   Sonnet under an Opus session WITH tools AND real budget.
  //   The naive "Sonnet under Opus" rule would mislabel 278/395 Sonnet calls
  //   because utility traffic is itself Sonnet under Opus. CV refuted it.
  if (adapterId === 'anthropic') {
    const toolCount = request.tools.length;
    const maxTokens = (() => {
      try {
        const p = JSON.parse(request.paramsJson) as Record<string, unknown>;
        const v = p.max_tokens;
        return typeof v === 'number' ? v : null;
      } catch {
        return null;
      }
    })();
    const messageCount = request.messages.length;

    // Utility: structural triple from CV-findings §3b.
    if (toolCount === 0 && maxTokens !== null && maxTokens <= 64 && messageCount <= 3) {
      return {
        role: 'utility',
        source: 'inferred',
        evidence: ['no-tools', `max_tokens<=${maxTokens}`, `message_count=${messageCount}`],
      };
    }

    // Subagent: refined Sonnet-under-Opus signal (CV §3a).
    // Conditions: current model is a smaller tier (sonnet/haiku) AND the session
    // has already seen a larger model (opus) AND tools present AND real budget.
    const currentModel = (request.model ?? '').toLowerCase();
    const isSmallerModel = currentModel.includes('sonnet') || currentModel.includes('haiku');
    const sessionHasLargerModel = sessionModels.some((m) => m.toLowerCase().includes('opus'));
    const hasTools = toolCount > 0;
    const hasRealBudget = maxTokens !== null && maxTokens > 64;

    if (isSmallerModel && sessionHasLargerModel && hasTools && hasRealBudget) {
      return {
        role: 'subagent',
        source: 'inferred',
        evidence: [
          `current-model:${currentModel}`,
          'session-has-opus',
          'has-tools',
          `max_tokens=${maxTokens}`,
        ],
      };
    }

    // Everything else: main.
    return {
      role: 'main',
      source: 'inferred',
      evidence: [
        toolCount > 0 ? 'has-tools' : 'no-tools',
        maxTokens !== null ? `max_tokens=${maxTokens}` : 'max_tokens:unknown',
        `message_count=${messageCount}`,
      ],
    };
  }

  // ---- Gemini: not inferrable from Vertex wire ----------------------------
  // Nothing distinguishes main / subagent / utility on the Vertex wire.
  // Return unknown rather than guess — honest unknown beats fabricated role.
  if (adapterId === 'gemini') {
    return {
      role: 'unknown',
      source: 'inferred',
      evidence: ['gemini-wire-undifferentiated'],
    };
  }

  // ---- Fallback -----------------------------------------------------------
  return {
    role: 'unknown',
    source: 'inferred',
    evidence: [`unknown-adapter:${adapterId}`],
  };
}
