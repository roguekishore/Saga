import {
  ConduitIngestPayloadSchema,
  type Logger,
  type NormalizedEvent,
  noopLogger,
} from '@saga/contracts';

/**
 * The CONDUIT → SAGA ingest seam — STUB. Implemented by C4.
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
 * C4: do not "optimize" this into a direct write. The test for it should assert
 * the invariant structurally, because it is the one most likely to be broken by
 * a later well-meaning change.
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
 * Handle one emit.
 *
 * ===========================================================================
 * TODO(C4): implement. Today it validates the frozen payload shape and rejects
 * malformed bodies, but pushes NOTHING — so a CONDUIT that ships early gets an
 * honest 501 instead of a silent 200 that drops its data on the floor.
 * ===========================================================================
 *
 * C4's checklist, from the spec:
 *  - Redact `rewritten_out` with `@saga/redact` BEFORE it reaches the queue. It
 *    arrives over HTTP rather than through the proxy's capture path, which is
 *    exactly why this is easy to forget — and it carries the same material the
 *    proxy scrubs.
 *  - Label metrics `upstream-reported`: Kiro is the provider on door A, so these
 *    figures outrank the observer's `gateway-computed` estimates. The writer
 *    already resolves the two by provenance rank in either arrival order.
 *  - Be idempotent. A retry must not double-count credits.
 *  - Unknown `request_id` is EXPECTED (SAGA restarted, or capture began after the
 *    request went out) — count it, never throw.
 *  - Verify `x-saga-request-id` is actually forwarded upstream before trusting
 *    the join. C0 fixed that; the whole seam is inert if it regresses, and it
 *    fails silently rather than loudly.
 */
export function handleConduitIngest(
  opts: IngestOptions,
  rawBody: unknown,
  byteLength: number,
): IngestResult {
  const log = opts.logger ?? noopLogger;
  const max = opts.maxBodyBytes ?? DEFAULT_MAX_INGEST_BYTES;

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

  log.log(
    'warn',
    'ingest',
    `conduit ingest received for ${parsed.data.request_id} but the seam is not implemented (C4); payload dropped`,
  );
  return {
    status: 501,
    body: { error: 'saga ingest seam not implemented yet (WS-C C4)', accepted: false },
  };
}
