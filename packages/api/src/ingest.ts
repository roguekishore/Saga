import {
  ConduitIngestPayloadSchema,
  type Logger,
  type NormalizedEvent,
  noopLogger,
} from '@saga/contracts';
import { type RedactionHit, scrubValue } from '@saga/redact';

/**
 * The CONDUIT → SAGA ingest seam.
 * Spec: `docs/ws-c/C4-conduit-ingest-seam.md`.
 * Contract: `D:/PROJECTS/AI/CONTRACT-conduit-saga-seam.md` (FROZEN — it outranks
 * both the spec and this comment).
 *
 * SAGA captures the clean-in request at its front door. Two things it cannot
 * see, and this seam supplies exactly those two:
 *   1. real metrics — they exist only after CONDUIT parses Kiro's response events;
 *   2. the rewritten-out payload — the rewrite happens INSIDE CONDUIT.
 * The diff (clean-in ⊖ rewritten-out) IS the injection SAGA renders as tags.
 *
 * ===========================================================================
 * THE RULE THAT SHAPES EVERYTHING HERE: this handler MUST NOT write to SQLite.
 *
 * `StoreWriter` is the single writer, consuming a bounded queue. So the handler
 * validates, redacts, pushes a `conduit_ingest` event, and returns. That is also
 * what makes the contract's fire-and-forget requirement free: the POST must
 * never delay or fail the client's response, and a synchronous DB write would
 * make a slow write CONDUIT's problem and therefore the user's.
 *
 * Do not "optimize" this into a direct write. The test for it asserts the
 * invariant structurally (no `db`/`Driver` parameter anywhere in this file's
 * signatures), because it is the one most likely to be broken by a later
 * well-meaning change.
 * ===========================================================================
 */

export interface IngestOptions {
  emit: (ev: NormalizedEvent) => void;
  logger?: Logger;
  /**
   * Cap on the JSON body. `rewritten_out` carries a full system prompt, history,
   * and tool specs, so this is not a formality — an uncapped body would let one
   * emit push an unbounded payload into the queue. There is precedent for a cap
   * in both the proxy (buffered capture bodies) and the SQL endpoint.
   *
   * C4: pick and state a defensible ceiling; reject over it with a clear status
   * rather than silently truncating.
   */
  maxBodyBytes?: number;
}

export interface IngestResult {
  status: number;
  body: unknown;
}

export const DEFAULT_MAX_INGEST_BYTES = 8 * 1024 * 1024;

/**
 * Handle one emit: validate against the frozen payload shape, redact
 * `rewritten_out`, and push a `conduit_ingest` event onto the capture queue via
 * `opts.emit`. Returns a small JSON ack; never throws.
 *
 * What this function deliberately does NOT do, and why:
 *  - No idempotency/dedup logic. A retry emits twice on purpose — dedup-by-
 *    `request_id` lives downstream in `StoreWriter.onConduitIngest` (the
 *    `prior.ingest_received_at != null` check), which is the only place with a
 *    prior state to compare against. This layer has none.
 *  - No handling for an unknown `request_id`. This layer cannot know the id is
 *    unknown without querying the DB, which it is forbidden from doing. The
 *    writer counts `ingest_unmatched` and drops it.
 *  - No provenance/label logic (`upstream-reported` / `metrics_source`). That
 *    also lives in the writer; this layer just gets a correctly-shaped payload
 *    onto the queue.
 */
export function handleConduitIngest(
  opts: IngestOptions,
  rawBody: unknown,
  byteLength: number,
): IngestResult {
  const log = opts.logger ?? noopLogger;
  const max = opts.maxBodyBytes ?? DEFAULT_MAX_INGEST_BYTES;

  try {
    if (byteLength > max) {
      return {
        status: 413,
        body: { error: `ingest body exceeds ${max} bytes` },
      };
    }

    const parsed = ConduitIngestPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      // A message specific enough for CONDUIT's author to debug against.
      return { status: 400, body: { error: `invalid ingest payload: ${parsed.error.message}` } };
    }

    const payload = parsed.data;

    // Redact `rewritten_out` BEFORE it reaches the queue. It arrives over HTTP
    // rather than through the proxy's capture path (which auto-redacts), and it
    // carries a full system prompt, message history, and tool specs — the same
    // material the proxy scrubs. `scrubValue` deep-scrubs the whole object:
    // sensitive keys wholesale, strings by pattern; it does not care that
    // `current_message`/`history`/`tools` are typed `z.unknown()`.
    let rewrittenOutJson: string | null = null;
    let hits: RedactionHit[] = [];
    let flagged = false;
    if (payload.rewritten_out) {
      const scrubbed = scrubValue(payload.rewritten_out);
      rewrittenOutJson = JSON.stringify(scrubbed.value);
      hits = scrubbed.hits;
      flagged = scrubbed.flagged;
    }

    const event: NormalizedEvent = {
      kind: 'conduit_ingest',
      requestId: payload.request_id,
      ts: payload.ts,
      payload,
      rewrittenOutJson,
      redaction: { hits, flagged },
    };

    opts.emit(event);

    return { status: 200, body: { accepted: true } };
  } catch (err) {
    // Never throw out of the handler — a bug here must cost this one POST, not
    // take the ingest route down for CONDUIT.
    log.log(
      'error',
      'ingest',
      `conduit ingest handler failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: 500, body: { error: 'internal error handling ingest payload' } };
  }
}
