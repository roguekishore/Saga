import { z } from 'zod';
import type { ContentBlock } from './blocks';

/**
 * Per-BLOCK provenance: which parts of a turn the human typed, and which the
 * client injected around it.
 *
 * Why this exists. On the Messages API there are only three places text can
 * live -- the top-level `system` field, and `messages[]` entries with role
 * `user` or `assistant`. A client that injects project context, recalled
 * memory, git status or slash-command output has no channel to say so: it all
 * arrives as role `user`. At the role level a typed sentence and an injected
 * CLAUDE.md are indistinguishable, which is why `contextSource` (per MESSAGE)
 * cannot answer "what did the human actually write".
 *
 * Measured on the live corpus (2026-09-04, 355 user-role messages / 662
 * blocks): Claude Code splits its injections into SEPARATE text blocks, so
 * classifying per block resolves most of it without slicing inside a block.
 *
 * Never stored. Block content feeds the dedup content hash, so tagging blocks
 * in place would rewrite every hash and break dedup against existing rows.
 * Deriving on read also means the heuristic can improve without re-capturing,
 * and applies to already-captured history.
 */

export const BlockContextKindSchema = z.enum([
  /** Unmarked prose in a user-role block: the best available guess at human input. */
  'user-prose',
  /** Unmarked text in the top-level `system` field — the harness identity/rules. */
  'system-prompt',
  /** `<system-reminder>` — harness-injected context wrapped around the turn. */
  'system-reminder',
  /** Recalled memory / project instructions (CLAUDE.md, MEMORY.md) inside an injection. */
  'memory',
  /** Slash-command echo: `<command-name>`, `<command-message>`, `<command-args>`. */
  'command-echo',
  /** Captured stdout of a locally-run command, plus its caveat wrapper. */
  'command-output',
  /** Other harness envelopes observed on the wire (`<transcript>`, `<session>`). */
  'harness',
  /** A tool result the client fed back in; structural, not prose. */
  'tool-result',
  /** Assistant-authored content (text, thinking, tool_use). */
  'model-output',
  /** Carries no text to classify (images, opaque reasoning). */
  'non-text',
]);
export type BlockContextKind = z.infer<typeof BlockContextKindSchema>;

export const BlockContextSchema = z.object({
  kind: BlockContextKindSchema,
  /**
   * True whenever the label came from marker sniffing rather than the wire.
   * `user-prose` is ALWAYS inferred: absence of a marker is weak evidence.
   * Measured counter-example in the corpus -- an 8.7 KB "Available agent types
   * for the Agent tool:" block, plainly injected, carrying no marker at all.
   * Structural labels (`tool-result`, `model-output`, `non-text`) read the
   * block's own type and are not inferred.
   */
  inferred: z.boolean(),
  /** The marker that decided it, for the UI to show its work. Null when none. */
  marker: z.string().nullable(),
});
export type BlockContext = z.infer<typeof BlockContextSchema>;

/** Leading-tag markers, longest-first so prefixes cannot shadow each other. */
const TAG_MARKERS: Array<{ tag: string; kind: BlockContextKind }> = [
  { tag: '<system-reminder>', kind: 'system-reminder' },
  { tag: '<local-command-caveat>', kind: 'command-output' },
  { tag: '<local-command-stdout>', kind: 'command-output' },
  { tag: '<user-prompt-submit-hook>', kind: 'command-output' },
  { tag: '<command-name>', kind: 'command-echo' },
  { tag: '<command-message>', kind: 'command-echo' },
  { tag: '<command-args>', kind: 'command-echo' },
  { tag: '<transcript>', kind: 'harness' },
  { tag: '<session>', kind: 'harness' },
];

/**
 * Injections that carry NO tag. Measured on the live corpus: several thousand-
 * to twenty-thousand-character blocks are plainly harness-authored yet arrive
 * as bare text, so a leading-tag check alone labels them "what the human
 * typed". Matched as a substring near the start, not a prefix.
 *
 * These are deliberately narrow and client-shaped, which makes them the most
 * brittle part of this module: a Claude Code release can reword any of them and
 * the block silently reverts to `user-prose`. That failure mode is why
 * `user-prose` is always `inferred` -- the list improving is expected, and the
 * label never claims more than sniffing can support.
 */
const UNTAGGED_INJECTIONS: Array<{ needle: string; kind: BlockContextKind }> = [
  { needle: 'Available agent types for the Agent tool:', kind: 'harness' },
  { needle: 'changed on disk since you last read it', kind: 'harness' },
  { needle: 'The following skills are available for use with the Skill tool:', kind: 'harness' },
  { needle: 'Codebase and user instructions are shown below', kind: 'memory' },
  { needle: "The following is the user's CLAUDE.md configuration", kind: 'memory' },
];

/** Recalled-memory signals; only consulted INSIDE an injected envelope. */
const MEMORY_MARKERS = ['# claudeMd', 'MEMORY.md', 'CLAUDE.md', "user's auto-memory"];

/**
 * Classify one block. `role` is the message's role: an assistant block is
 * model output regardless of what its text looks like, so a model quoting
 * `<system-reminder>` back is never mistaken for an injection.
 */
export function classifyBlock(block: ContentBlock, role: string): BlockContext {
  switch (block.type) {
    case 'tool_result':
      return { kind: 'tool-result', inferred: false, marker: null };
    case 'tool_use':
    case 'thinking':
      return { kind: 'model-output', inferred: false, marker: null };
    case 'image':
    case 'redacted_thinking':
      return { kind: 'non-text', inferred: false, marker: null };
    case 'unknown':
      return { kind: 'harness', inferred: true, marker: block.rawType };
    case 'text':
      break;
  }

  if (role === 'assistant') return { kind: 'model-output', inferred: false, marker: null };

  const text = block.text.trimStart();
  // The system field is a declared wire location, so its text needs no guess.
  // Checked BEFORE marker sniffing would reach the user-prose fallback: the
  // live corpus has a system block that MENTIONS CLAUDE.md and
  // <system-reminder> mid-text without leading with either, and calling that
  // "what the human typed" would be flatly wrong.
  if (role === 'system') {
    const mem = MEMORY_MARKERS.find((m) => block.text.includes(m));
    return mem
      ? { kind: 'memory', inferred: true, marker: mem }
      : { kind: 'system-prompt', inferred: false, marker: null };
  }

  for (const { tag, kind } of TAG_MARKERS) {
    if (!text.startsWith(tag)) continue;
    // An injected envelope carrying project instructions is memory recall
    // first and an envelope second -- that is the distinction users care about.
    if (kind === 'system-reminder') {
      const mem = MEMORY_MARKERS.find((m) => block.text.includes(m));
      if (mem) return { kind: 'memory', inferred: true, marker: `${tag} + ${mem}` };
    }
    return { kind, inferred: true, marker: tag };
  }

  // A serialized transcript or tool-call record fed back in. Detected by
  // structure rather than a needle: the corpus holds both `{"user": ...}`
  // (role-keyed turns) and `{"Bash": "..."}` (tool-keyed calls), and enumerating
  // every possible first key would go stale immediately.
  //
  // The tradeoff, stated plainly: JSON a human genuinely pasted is caught too.
  // That is the intended direction of error -- calling a replayed transcript
  // "what you typed" defeats the whole point of this module, while a pasted
  // payload mislabeled as structured data is a cosmetic miss. It stays
  // `inferred` either way. Parse is attempted only for `{"`-leading text, and
  // skipped past a size ceiling so a pathological block cannot stall a render.
  if (text.startsWith('{"')) {
    // Valid JSON is the strong signal, but only for blocks small enough to
    // parse without stalling a render.
    if (text.length < 200_000) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { kind: 'harness', inferred: true, marker: 'serialized JSON record' };
        }
      } catch {
        // Fall through to the shape check below.
      }
    }
    // Parse failure does NOT mean prose. The corpus's largest offenders are
    // TRUNCATED dumps (a 21 KB `{"user":"..."` cut mid-string) and blobs
    // carrying raw control characters -- both invalid JSON, both unmistakably
    // machine-written. An opening `{"key":` is enough to say "structured
    // record", so match the shape and accept the tradeoff already stated above.
    if (/^\{\s*"[^"\n]{1,80}"\s*:/.test(text)) {
      return { kind: 'harness', inferred: true, marker: 'serialized record (unparseable)' };
    }
  }

  // Untagged injections: scan only the opening window. A needle appearing deep
  // inside a long block is far more likely to be someone quoting it than the
  // harness speaking, and a whole-block search made exactly that mistake.
  const window = text.slice(0, 400);
  for (const { needle, kind } of UNTAGGED_INJECTIONS) {
    if (window.includes(needle)) return { kind, inferred: true, marker: needle };
  }

  return { kind: 'user-prose', inferred: true, marker: null };
}

/** Classify every block of a message, positionally parallel to `blocks`. */
export function classifyBlocks(blocks: ContentBlock[], role: string): BlockContext[] {
  return blocks.map((b) => classifyBlock(b, role));
}
