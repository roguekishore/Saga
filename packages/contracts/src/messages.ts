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
});
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;
