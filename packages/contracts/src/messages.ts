import { z } from 'zod';
import { ContentBlockSchema } from './blocks';

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Why a message is in the prompt. Only `system`/`user`/`assistant`/`tool`
 * fall straight out of the payload; `memory`/`history`/`spec` are heuristics
 * decided in the client before the request and invisible on the wire — when
 * SAGA assigns one, `contextSourceInferred` is true and the UI says so.
 */
export const ContextSourceSchema = z.enum([
  'system',
  'user',
  'assistant',
  'memory',
  'history',
  'tool',
  'spec',
  'unknown',
]);
export type ContextSource = z.infer<typeof ContextSourceSchema>;

export const NormalizedMessageSchema = z.object({
  role: RoleSchema,
  blocks: z.array(ContentBlockSchema),
  contextSource: ContextSourceSchema,
  contextSourceInferred: z.boolean(),
  /**
   * Wall clock of the FIRST request observed to carry this exact message body
   * (`messages.created_at`, which insert sets and the dedup ON CONFLICT path
   * deliberately never overwrites). Read-side only, hence optional: adapters
   * omit it, the ReadAPI fills it in. It is NOT part of the content hash.
   *
   * First-observed, NOT sent-at, and the UI must say so. Two consequences:
   * byte-identical repeats collapse onto their first sighting, and a system
   * prompt that never changes keeps the timestamp of the first request that
   * ever carried it. Where it precedes the request's own `ts`, the message was
   * already in the context before this turn -- that part is wire evidence.
   */
  firstObservedAt: z.number().nullable().optional(),
});
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

/** Tool definition metadata. Full defs live in the redacted raw request. */
export const ToolDefSummarySchema = z.object({
  name: z.string(),
  descriptionBytes: z.number().int().nonnegative(),
  inputSchemaBytes: z.number().int().nonnegative(),
});
export type ToolDefSummary = z.infer<typeof ToolDefSummarySchema>;

/** The request side, normalized by an adapter and already redacted. */
export const NormalizedRequestSchema = z.object({
  model: z.string().nullable(),
  stream: z.boolean(),
  /** System prompt as messages (some providers allow block arrays). */
  system: z.array(NormalizedMessageSchema),
  messages: z.array(NormalizedMessageSchema),
  tools: z.array(ToolDefSummarySchema),
  /** Sampling params etc., redacted JSON — small, provider-shaped. */
  paramsJson: z.string(),
  /** Entire request body, redacted. The Prompt Inspector's Raw JSON tab. */
  rawRequestJson: z.string(),
  /**
   * Session id the CLIENT stated on the wire, when it states one at all.
   * Claude Code puts it in `metadata.user_id` (a JSON string) on every
   * `/v1/messages` call, and it is the same uuid that names the transcript at
   * `~/.claude/projects/<slug>/<uuid>.jsonl`.
   *
   * This is WIRE EVIDENCE, not a heuristic — the one signal that says "these
   * requests are one conversation" without SAGA having to guess. Null whenever
   * the client says nothing (other clients, `count_tokens`, non-Anthropic
   * shapes), which is when the fingerprint/idle heuristic takes over.
   *
   * Optional so adapters predating it keep type-checking; every in-repo
   * adapter sets it explicitly.
   */
  clientSessionId: z.string().nullable().optional(),

  // ---- WS-C: the adapter's channel for things only it can read.
  //
  // These live on NormalizedRequest because the ADAPTER is what parses a
  // provider's body and headers, and the capture layer must stay
  // provider-agnostic — provider differences belong in adapters, never as
  // branching in the capture path. All optional, so an adapter that predates
  // them keeps type-checking and the six WS-C workstreams land independently.

  /**
   * Identity the harness declared, verbatim. Coverage is deliberately uneven:
   * Codex fills all four from `client_metadata`, Claude Code fills `sessionId`
   * only, Gemini-Vertex fills none.
   *
   * Codex trap: the `session-id` HEADER is the prompt-cache key, NOT the
   * session. The session lives in the body at `client_metadata.session_id`.
   */
  harnessIdentity: z
    .object({
      sessionId: z.string().nullable().default(null),
      threadId: z.string().nullable().default(null),
      turnId: z.string().nullable().default(null),
      parentTurnId: z.string().nullable().default(null),
    })
    .nullable()
    .optional(),

  /**
   * Cost/latency tier, which BOTH feeds carry in their own dialect: Codex
   * `service_tier` ∈ {priority, flex}; Gemini's `X-Vertex-AI-LLM-Request-Type` /
   * `-Shared-Request-Type`. Identical token counts can cost and latch
   * differently by tier, which is why the benchmarking thesis needs it.
   */
  routingTier: z.string().nullable().optional(),

  /**
   * Injections the adapter can see on the front door, before any gateway —
   * Codex `user_instructions`/`environment_context`, Gemini `session_context`.
   * These are `saga-observed`; CONDUIT's self-declared ones arrive separately
   * over the ingest seam and are `conduit-declared`.
   */
  injections: z
    .array(
      z.object({
        type: z.string(),
        location: z.string().nullable().default(null),
        detail: z.string().nullable().default(null),
      }),
    )
    .optional(),

  /**
   * A stable partition to key a synthesized session on when the client declares
   * none — Gemini's install-scoped `x-gemini-api-privileged-user-id`.
   *
   * NOT a session id, and never to be presented as one: it identifies an
   * installation, so every conversation from one machine shares it.
   */
  syntheticSessionKey: z.string().nullable().optional(),
});
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;
