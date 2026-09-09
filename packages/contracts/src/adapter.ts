import { z } from 'zod';
import type { NormalizedEvent } from './events';
import type { NormalizedRequest } from './messages';

/**
 * Provider differences live in adapters ONLY — no provider branching in the
 * capture path. Adding a provider means adding an adapter, nothing else.
 *
 * Adapters are pure: the capture layer owns clocks, ids, and the queue, and
 * injects timestamps. That keeps adapters replayable against fixtures.
 */

/** One parsed SSE frame. `data` is the raw string; `json` set when it parsed. */
export const SseFrameSchema = z.object({
  event: z.string().nullable(),
  data: z.string(),
  json: z.unknown().nullable(),
});
export type SseFrame = z.infer<typeof SseFrameSchema>;

export interface AdapterRequestContext {
  method: string;
  /** Path + query as received, e.g. `/v1/messages?beta=true`. */
  path: string;
  /** Lower-cased header map, sensitive values already redacted. */
  headers: Record<string, string>;
  /** Parsed request body (untrusted; adapter validates shape itself). */
  body: unknown;
}

/** Emitted by observers: everything but ids/timestamps, which capture stamps. */
export type DerivedEvent = {
  partial: Omit<NormalizedEvent, 'requestId' | 'ts'> & { kind: NormalizedEvent['kind'] };
};

export interface StreamObserver {
  /** Feed one SSE frame (already tail-buffered by the capture layer). */
  onFrame(frame: SseFrame): void;
  /** Feed a complete non-streaming JSON body. */
  onCompleteBody(body: unknown): void;
  /** True once a content-bearing frame has been seen (drives first_token). */
  sawFirstContent(): boolean;
  /** Cumulative output tokens as reported on the wire so far, if any. */
  outputTokensSoFar(): { value: number; source: 'upstream-reported' | 'gateway-computed' } | null;
  /**
   * Additive (post-freeze, optional): content chars accumulated since the
   * last poll, for throttled token_stream ticks. Resets on read.
   */
  deltaSinceLastPoll?(): {
    blockType: 'text' | 'thinking' | 'tool_use' | 'unknown';
    chars: number;
  } | null;
  /**
   * Additive (P3, optional): tool_use blocks fully assembled since the last
   * poll. Lets capture emit tool_use_observed at real in-stream time instead
   * of at finalize. Resets on read.
   */
  drainCompletedToolUses?(): Array<{
    blockIndex: number;
    toolUseId: string;
    name: string;
    inputJson: string | null;
  }>;
  /**
   * Finish and return the response-side result. Called exactly once, on
   * stream end, abort, or error.
   */
  finalize(reason: 'complete' | 'client_aborted' | 'upstream_error'): ObserverResult;
}

export interface ObserverResult {
  usage: import('./provenance').Usage;
  stopReason: string | null;
  message: import('./messages').NormalizedMessage | null;
  toolUses: Array<{
    blockIndex: number;
    toolUseId: string;
    name: string;
    inputJson: string | null;
  }>;
  frameStats: { frames: number; bytes: number; parseErrors: number };
}

export interface Adapter {
  /** Stable id, e.g. `anthropic`. Persisted on every request row. */
  id: string;
  /** Payload-shape family, e.g. `anthropic-messages`, `openai-chat`. */
  provider: string;
  displayName: string;
  /** Route match against an incoming proxy request. */
  matches(ctx: AdapterRequestContext): boolean;
  /** Normalize + redact the request side. Must never throw on weird shapes. */
  normalizeRequest(ctx: AdapterRequestContext): NormalizedRequest;
  /** Fresh observer per request. */
  createObserver(): StreamObserver;
}
