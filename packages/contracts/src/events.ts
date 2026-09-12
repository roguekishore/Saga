import { z } from 'zod';
import { NormalizedMessageSchema, NormalizedRequestSchema } from './messages';
import { UsageSchema, UsageValueSchema } from './provenance';

/**
 * `NormalizedEvent` — what every adapter emits and the store persists.
 *
 * The reference upstream has NO event stream; these are derived by SAGA from
 * observing SSE frames as it proxies. Timestamps are epoch milliseconds
 * stamped by the capture layer, not by the provider.
 */

export const RequestStatusSchema = z.enum([
  'ok',
  'upstream_error',
  'client_aborted',
  'capture_incomplete',
]);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

/**
 * Which front door a request arrived on. SAGA runs two capture doors feeding
 * one store:
 *
 * - `A` → CONDUIT. Serves Claude Code (`/v1/messages`) AND Codex
 *   (`/v1/responses`). Real metrics arrive later over the ingest seam, because
 *   they only exist after CONDUIT parses Kiro's response events.
 * - `B` → Google. Serves Gemini as a plain passthrough, so SAGA sees the real
 *   request and response itself and parses usage natively. No seam involved.
 *
 * This distinction is not cosmetic: it decides where a row's metrics come from,
 * whether a credit figure can exist at all, and whether an absent seam payload
 * is "pending" or "never". See the two-feed rule in docs/ws-c/README.md.
 */
export const DoorSchema = z.enum(['A', 'B']);
export type Door = z.infer<typeof DoorSchema>;

/** Which client is speaking. Read from client-name/user-agent + endpoint. */
export const HarnessSchema = z.enum(['claude-code', 'codex', 'gemini-cli', 'unknown']);
export type Harness = z.infer<typeof HarnessSchema>;

/**
 * How a claim was arrived at. The existing `client-declared` / `inferred` split
 * on sessions is the model, and every new grouping or classification in the
 * hierarchy carries the same distinction: the UI must be able to tell a reader
 * which rows are wire evidence and which are SAGA's guess.
 *
 * `harness-declared` is deliberately a different word from the session layer's
 * `client-declared` — it marks a turn or role the HARNESS stated (Codex states
 * both), keeping it distinguishable from a session id the client stated.
 */
export const ClaimSourceSchema = z.enum(['harness-declared', 'inferred']);
export type ClaimSource = z.infer<typeof ClaimSourceSchema>;

/**
 * Is this request a fresh human instruction, or another round-trip of the loop
 * an earlier instruction started?
 *
 * One human message is NOT one model call: it opens an agentic loop that runs
 * until the model answers with no tool call (~4 requests typical, 30+ for large
 * tasks), and every request re-ships the whole growing conversation. So a turn
 * is the unit a human would recognize as "the thing I asked for".
 */
export const TurnBoundaryKindSchema = z.enum(['human_turn', 'tool_continuation', 'unknown']);
export type TurnBoundaryKind = z.infer<typeof TurnBoundaryKindSchema>;

/**
 * main / subagent / utility. Utility is Claude Code's internal helper traffic
 * (titling, compaction) and Codex's `compact`/`memory_consolidation` — it must
 * fold into the enclosing conversation rather than appear as one of its own.
 *
 * `unknown` is a legitimate answer, not a failure: Gemini's Vertex wire carries
 * nothing that would distinguish these, and guessing would be worse.
 */
export const CallRoleSchema = z.enum(['main', 'subagent', 'utility', 'unknown']);
export type CallRole = z.infer<typeof CallRoleSchema>;

/**
 * One context injection, surfaced as a tag.
 *
 * Two sources, and the difference matters to a reader:
 * - `saga-observed` — present on the front door before any gateway, so SAGA saw
 *   it directly (Codex `user_instructions`, Gemini `session_context`).
 * - `conduit-declared` — CONDUIT self-declares what it added, because the
 *   rewrite happens inside CONDUIT and is invisible to a front-door proxy.
 *   This is the blind-spot fix: SAGA displays what CONDUIT reports.
 */
export const InjectionSchema = z.object({
  type: z.string(),
  location: z.string().nullable().default(null),
  source: z.enum(['saga-observed', 'conduit-declared']),
  /** Optional redacted detail (e.g. a marker's position). Never raw content. */
  detail: z.string().nullable().default(null),
});
export type Injection = z.infer<typeof InjectionSchema>;

const base = {
  requestId: z.string(),
  ts: z.number(),
};

export const RequestStartedSchema = z.object({
  ...base,
  kind: z.literal('request_started'),
  /**
   * The session this request belongs to. Whether that boundary is evidence or
   * a guess is `sessionIdSource` — read them together, never this alone.
   */
  sessionId: z.string(),
  /**
   * How the boundary was decided. `client-declared` means the client stated
   * its own session id on the wire (Claude Code does, on every
   * `/v1/messages`); `inferred` means SAGA guessed from client, workspace and
   * idle time, and the UI must say so.
   *
   * Defaults to `inferred` deliberately: the weaker claim is the safe one, so
   * an emitter that forgets this field cannot accidentally assert wire truth.
   */
  sessionIdSource: z.enum(['client-declared', 'inferred']).default('inferred'),
  /**
   * The raw client-stated session id, when there was one. For Claude Code this
   * is the uuid naming `~/.claude/projects/<slug>/<uuid>.jsonl`, which is what
   * lets local transcript enrichment find the conversation. Null otherwise.
   */
  clientSessionId: z.string().nullable().default(null),
  adapterId: z.string(),
  provider: z.string(),
  endpoint: z.string(),
  method: z.string(),
  upstreamUrl: z.string(),
  clientName: z.string().nullable(),
  /** Workspace path heuristically extracted from the system prompt; inferred. */
  workspace: z.string().nullable(),
  model: z.string().nullable(),
  stream: z.boolean(),
  request: NormalizedRequestSchema,
  redaction: z.object({
    hits: z.array(z.object({ kind: z.string(), count: z.number().int().nonnegative() })),
    /** Fail-closed flag: an unrecognized high-entropy blob was scrubbed. */
    flagged: z.boolean(),
  }),
  /**
   * Additive (P3): agent correlation. HEURISTIC — distinct system-prompt
   * fingerprints within a session become agents; a new agent whose first
   * request starts while another agent's request is in flight is inferred to
   * be its child. Never wire truth; the UI labels it inferred.
   */
  agent: z
    .object({
      agentId: z.string(),
      parentAgentId: z.string().nullable(),
      label: z.string(),
    })
    .nullable()
    .optional(),

  // ---- WS-C hierarchy fields.
  //
  // Every one of these defaults, and every `*Source` among them defaults to the
  // WEAKER claim, for the same reason `sessionIdSource` does: an emitter that
  // forgets a field must not accidentally assert wire truth. Silence means "we
  // do not know", never "the harness told us".

  /** Which capture door this arrived on. Decides the metrics feed. */
  door: DoorSchema.default('A'),
  harness: HarnessSchema.default('unknown'),
  /**
   * Cost/latency tier — a dimension BOTH feeds carry: Codex `service_tier`
   * ∈ {priority, flex}, Gemini's Vertex request-type header. Directly relevant
   * to the benchmarking thesis, since identical token counts can cost and latch
   * differently by tier.
   */
  routingTier: z.string().nullable().default(null),

  /** Turn grouping — which human instruction's loop this request belongs to. */
  turn: z
    .object({
      turnId: z.string(),
      /** Ordinal within the session. */
      seq: z.number().int().nonnegative(),
      kind: TurnBoundaryKindSchema,
      source: ClaimSourceSchema.default('inferred'),
      /** Codex states this; Claude Code and Gemini do not. */
      harnessTurnId: z.string().nullable().default(null),
      /** True when this request opened the turn (a human instruction). */
      opened: z.boolean(),
      /**
       * True when the turn was opened by a continuation with no open turn —
       * SAGA restarted mid-loop, or capture began mid-conversation. The turn is
       * genuinely partial and the UI must be able to say so rather than
       * presenting a fabricated complete one.
       */
      partial: z.boolean().default(false),
      /** Which markers or structure drove the decision. For UI honesty. */
      evidence: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),

  callRole: z
    .object({
      role: CallRoleSchema,
      source: ClaimSourceSchema.default('inferred'),
      evidence: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),

  /**
   * Identity the HARNESS declared, verbatim off the wire — never reformatted,
   * because downstream code treats it as ground truth.
   *
   * Coverage is deliberately uneven and must not be flattened: Codex fills all
   * four (from `client_metadata`), Claude Code fills `sessionId` only, and
   * Gemini-Vertex fills NONE. Reserving all four means the good harnesses group
   * by declared id and only Gemini falls back to a synthesized key, rather than
   * forcing every harness onto the lowest common denominator.
   */
  harnessIdentity: z
    .object({
      sessionId: z.string().nullable().default(null),
      threadId: z.string().nullable().default(null),
      turnId: z.string().nullable().default(null),
      parentTurnId: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),

  /**
   * Injections SAGA saw itself on the front door, before any gateway. The
   * CONDUIT-declared ones arrive separately over the ingest seam.
   */
  injections: z.array(InjectionSchema).default([]),
});
export type RequestStarted = z.infer<typeof RequestStartedSchema>;

export const FirstTokenSchema = z.object({
  ...base,
  kind: z.literal('first_token'),
  /** Client-observed time to first content frame, measured at the proxy. */
  ttftMs: z.number().nonnegative(),
});
export type FirstToken = z.infer<typeof FirstTokenSchema>;

/** Throttled progress tick for live UI counters; not persisted per-tick. */
export const TokenStreamSchema = z.object({
  ...base,
  kind: z.literal('token_stream'),
  blockType: z.enum(['text', 'thinking', 'tool_use', 'unknown']),
  deltaChars: z.number().int().nonnegative(),
  /** Cumulative output tokens if the wire reported them; null otherwise. */
  outputTokens: UsageValueSchema.nullable(),
});
export type TokenStream = z.infer<typeof TokenStreamSchema>;

export const ToolUseObservedSchema = z.object({
  ...base,
  kind: z.literal('tool_use_observed'),
  blockIndex: z.number().int().nonnegative(),
  toolUseId: z.string(),
  name: z.string(),
  /** Redacted input JSON as assembled from the stream. */
  inputJson: z.string().nullable(),
});
export type ToolUseObserved = z.infer<typeof ToolUseObservedSchema>;

export const ResponseFinishedSchema = z.object({
  ...base,
  kind: z.literal('response_finished'),
  status: RequestStatusSchema,
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative().nullable(),
  usage: UsageSchema,
  stopReason: z.string().nullable(),
  /** Assembled assistant message, redacted. Null when nothing arrived. */
  message: NormalizedMessageSchema.nullable(),
  error: z.object({ type: z.string(), message: z.string() }).nullable(),
  frameStats: z.object({
    frames: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    parseErrors: z.number().int().nonnegative(),
  }),
  redaction: z.object({
    hits: z.array(z.object({ kind: z.string(), count: z.number().int().nonnegative() })),
    flagged: z.boolean(),
  }),
});
export type ResponseFinished = z.infer<typeof ResponseFinishedSchema>;

/** A capture-side failure. Never affects the forward path; always visible. */
export const CaptureErrorSchema = z.object({
  ...base,
  kind: z.literal('capture_error'),
  where: z.string(),
  message: z.string(),
});
export type CaptureError = z.infer<typeof CaptureErrorSchema>;

/**
 * The CONDUIT → SAGA seam payload, schema v1.
 *
 * FROZEN by `D:/PROJECTS/AI/CONTRACT-conduit-saga-seam.md`. Neither side owns
 * it: change it only by editing that file, bumping the version, and telling the
 * other side. It is spelled here in the contract's own **snake_case** rather
 * than translated to SAGA's camelCase deliberately — CONDUIT and SAGA are
 * separate repos built in parallel, and a re-spelling is a place for the two to
 * drift silently. This is the wire, verbatim; the store maps it inward.
 *
 * It supplies exactly the two things a front-door proxy cannot see:
 *  1. real metrics — they exist only after CONDUIT parses Kiro's events;
 *  2. the rewritten-out payload — the rewrite happens INSIDE CONDUIT.
 *
 * The diff (clean-in ⊖ rewritten-out) IS the injection SAGA renders as tags.
 */
export const ConduitIngestPayloadSchema = z.object({
  /** Matches the id SAGA assigned at its front door and forwarded upstream. */
  request_id: z.string().min(1),
  ts: z.number(),
  /** The model actually sent to Kiro, after CONDUIT resolved it. */
  model_id: z.string().nullable().default(null),

  metrics: z
    .object({
      input_tokens: z.number().int().nonnegative().nullable().default(null),
      output_tokens: z.number().int().nonnegative().nullable().default(null),
      /** Reasoning, metered by Kiro as its own line item. */
      thought_tokens: z.number().int().nonnegative().nullable().default(null),
      cache_read_tokens: z.number().int().nonnegative().nullable().default(null),
      cache_write_tokens: z.number().int().nonnegative().nullable().default(null),
      total_tokens: z.number().int().nonnegative().nullable().default(null),
      /** meteringEvent raw credit count. Null on the Gemini feed by definition. */
      credits: z.number().nullable().default(null),
      context_usage_percentage: z.number().nullable().default(null),
      stop_reason: z.string().nullable().default(null),
      reasoning_blocks: z
        .array(
          z.object({
            model_id: z.string().nullable().default(null),
            signature_present: z.boolean().default(false),
          }),
        )
        .default([]),
    })
    .nullable()
    .default(null),

  rewritten_out: z
    .object({
      system_prompt: z.string().nullable().default(null),
      current_message: z.unknown().nullable().default(null),
      history: z.array(z.unknown()).default([]),
      tools: z.array(z.unknown()).default([]),
      /**
       * CONDUIT self-declares what it added rather than making SAGA
       * reverse-engineer the diff. SAGA may still diff to verify.
       */
      injections: z
        .array(
          z.object({
            type: z.string(),
            location: z.string().nullable().default(null),
          }),
        )
        .default([]),
    })
    .nullable()
    .default(null),
});
export type ConduitIngestPayload = z.infer<typeof ConduitIngestPayloadSchema>;

/**
 * A seam payload that arrived and is on its way to the store.
 *
 * WHY THIS IS AN EVENT AND NOT A DIRECT WRITE — read before changing C4:
 * `StoreWriter` is the single writer, consuming a bounded queue. The ingest
 * endpoint therefore validates, redacts, pushes this, and returns. That is also
 * what makes the contract's fire-and-forget requirement free: the POST must
 * never delay or fail the client's response, and a synchronous DB write would
 * make a slow write CONDUIT's problem and therefore the user's.
 *
 * `rewrittenOut` is REDACTED before it gets here, like everything else that
 * reaches the queue. It carries a full system prompt, history, and tool specs —
 * the same material the proxy scrubs.
 */
export const ConduitIngestSchema = z.object({
  ...base,
  kind: z.literal('conduit_ingest'),
  payload: ConduitIngestPayloadSchema,
  /** Redacted `rewritten_out`, serialized. Stored as a deduped message row. */
  rewrittenOutJson: z.string().nullable().default(null),
  redaction: z.object({
    hits: z.array(z.object({ kind: z.string(), count: z.number().int().nonnegative() })),
    flagged: z.boolean(),
  }),
});
export type ConduitIngest = z.infer<typeof ConduitIngestSchema>;

export const NormalizedEventSchema = z.discriminatedUnion('kind', [
  RequestStartedSchema,
  FirstTokenSchema,
  TokenStreamSchema,
  ToolUseObservedSchema,
  ResponseFinishedSchema,
  CaptureErrorSchema,
  ConduitIngestSchema,
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
export type NormalizedEventKind = NormalizedEvent['kind'];
