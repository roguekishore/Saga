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

export const NormalizedEventSchema = z.discriminatedUnion('kind', [
  RequestStartedSchema,
  FirstTokenSchema,
  TokenStreamSchema,
  ToolUseObservedSchema,
  ResponseFinishedSchema,
  CaptureErrorSchema,
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
export type NormalizedEventKind = NormalizedEvent['kind'];
