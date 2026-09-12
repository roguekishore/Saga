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
 * ===========================================================================
 * TODO(C3): implement. Returns `unknown`/`inferred` until then — a WORKING
 * state, and for Gemini the permanently correct one.
 * ===========================================================================
 *
 * C3, what the spec establishes:
 *
 * DECLARED, for Codex only. `x-openai-subagent` ∈ {review, compact,
 * memory_consolidation, collab_spawn, custom}: absent → `main`;
 * `compact`/`memory_consolidation` → `utility`; anything else → `subagent`.
 * Source is `'harness-declared'`. C2 surfaces the raw value.
 *
 * FINGERPRINTED, for Claude Code (`source: 'inferred'`):
 *   main     — big system prompt + full tool set + long run
 *   subagent — a DIFFERENT large prompt overlapping a main call in time
 *   utility  — tiny prompt + no tools + small budget + cheap model
 *
 * One strong extra Claude Code signal, and the reason `sessionModels` is in this
 * signature: a Sonnet request under an otherwise-Opus session is a reliable
 * subagent marker, because Claude Code drops subagents to Sonnet by default.
 * CV's report says whether real rows bear this out — IF CV REFUTED IT, DO NOT
 * USE IT, and say so.
 *
 * NOT INFERRABLE for Gemini. The Vertex wire carries nothing that distinguishes
 * these. Return `'unknown'` rather than guessing; the schema has a slot for it
 * and an honest unknown beats a fabricated role.
 *
 * `evidence` is not decoration — it records WHY, so a reader can check a label
 * instead of trusting it. Populate it even for `unknown`, where the evidence is
 * what you looked for and did not find.
 */
export function classifyCallRole(_input: {
  request: NormalizedRequest;
  headers: Record<string, string>;
  adapterId: string;
  door: Door;
  /** Models already seen in this session — drives the Sonnet-under-Opus signal. */
  sessionModels: string[];
}): CallRoleClassification {
  return { role: 'unknown', source: 'inferred', evidence: [] };
}
