import { z } from 'zod';

/**
 * Polymorphic content blocks — the reason `NormalizedEvent` exists at all.
 * `thinking` is a first-class block on the reference upstream (delivered as
 * `thinking_delta` frames, carrying a `signature`), so it is first-class here.
 *
 * Image blocks NEVER carry data: SAGA stores prompts and responses, never file
 * contents, binaries, or images. Only shape metadata survives normalization.
 *
 * `unknown` is the fail-open-on-structure escape hatch: tool frame shapes are
 * unverified upstream, so anything unrecognized is preserved as redacted raw
 * JSON instead of being dropped or force-fit.
 */

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  /** Present on the reference upstream; opaque, verbatim. */
  signature: z.string().nullable(),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

/** Provider-encrypted reasoning. Opaque payload, safe to store verbatim. */
export const RedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
});
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlockSchema>;

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  /** Redacted, parsed input. Null when the stream aborted mid-JSON. */
  input: z.unknown().nullable(),
  /** Redacted raw input JSON as observed on the wire (partial if aborted). */
  inputJson: z.string().nullable(),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

export const ImageBlockSchema = z.object({
  type: z.literal('image'),
  mediaType: z.string().nullable(),
  /** Size of the omitted payload, when known. */
  byteSize: z.number().int().nonnegative().nullable(),
  note: z.literal('content-not-stored'),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  isError: z.boolean(),
  /** Normalized to blocks; providers send string | block[]. */
  content: z.array(z.union([TextBlockSchema, ImageBlockSchema])),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

export const UnknownBlockSchema = z.object({
  type: z.literal('unknown'),
  /** The provider's own type tag, e.g. a future block kind. */
  rawType: z.string(),
  /** Redacted JSON of the whole block. */
  json: z.string(),
});
export type UnknownBlock = z.infer<typeof UnknownBlockSchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  UnknownBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** Plain text of a block list, for FTS indexing and size accounting. */
export function blocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        parts.push(b.text);
        break;
      case 'thinking':
        parts.push(b.thinking);
        break;
      case 'tool_use':
        parts.push(`${b.name} ${b.inputJson ?? ''}`);
        break;
      case 'tool_result':
        for (const c of b.content) if (c.type === 'text') parts.push(c.text);
        break;
      case 'unknown':
        parts.push(b.json);
        break;
      case 'redacted_thinking':
      case 'image':
        break;
    }
  }
  return parts.join('\n');
}
