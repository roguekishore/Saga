import type { TurnDetail, TurnList } from '@saga/contracts';
import type { Driver } from '@saga/store';

/**
 * The hierarchy read path — STUB. Implemented by C5.
 * Spec: `docs/ws-c/C5-hierarchy-read-api.md`. Response shapes are FROZEN in
 * `@saga/contracts` (`TurnSummarySchema`, `ExchangeSchema`) — C6 renders exactly
 * those, so a divergence here is a divergence between two workstreams.
 *
 * Serves: project → conversation → human message → the requests it triggered →
 * injection tags. The point is not session browsing; it is to make context
 * injection legible at the granularity of one instruction.
 *
 * ===========================================================================
 * TODO(C5): implement. Returns empty results until then — an empty hierarchy is
 * indistinguishable from a session with no turns yet, so C6 can build against
 * fixtures without this lying to it.
 * ===========================================================================
 *
 * C5, the constraints that actually bite (all from the spec):
 *
 *  - READ ONLY. Take the readonly connection. The collector opens a separate
 *    readonly handle precisely so WAL lets reads proceed while the writer writes.
 *    Do not write a cache table or a lazy rollup — that is the single writer's
 *    job, and if you find you want one, report it rather than adding it.
 *
 *  - PROVENANCE MUST SURVIVE AGGREGATION. Use `AggUsage` for rollups: it carries
 *    `sources[]` so a turn mixing a gateway-computed request with an
 *    upstream-reported one can say "mixed" honestly. Never average provenance
 *    away, never pick one source to stand for the group.
 *
 *  - NULL IS NOT ZERO. `credits` is null across the entire Gemini feed (Vertex
 *    bills GCP-side); cache counters are null on doors that do not report them. A
 *    `COALESCE(x, 0)` in a rollup turns "we do not know" into "it was zero",
 *    which is a lie the UI cannot detect. Sum what exists and report how many
 *    rows contributed.
 *
 *  - THREE STATES, NOT TWO. `seamStatus` distinguishes `pending` (door A,
 *    `ingest_received_at` null — the normal state until CONDUIT ships) from
 *    `not-applicable` (door B, which will never have a seam payload) from
 *    `present`. Collapsing these would make "waiting" look like "nothing".
 *
 *  - `contextUsageReadings` GOES BACK ORDERED AND UNAGGREGATED. Kiro returns the
 *    figure on every response, so one turn yields N readings that climb as the
 *    re-shipped conversation grows. That is the agentic loop made visible, and
 *    the count is the number of round-trips. Averaging destroys the only
 *    interesting thing about it.
 *
 *  - `endedAt` is LAST OBSERVED ACTIVITY, not a closing boundary — nothing on the
 *    wire declares an instruction finished. Deciding "is this turn still open?"
 *    is the read layer's call: compare against the session's latest turn and the
 *    clock.
 *
 *  - PERFORMANCE, measured facts from this codebase: raw `GROUP BY` over 912k
 *    requests ran 550-700ms against a 200ms target (hence `stats_daily`), and
 *    `/api/storage` took a 20s TTL cache at ~285ms because a 15s poll hits it.
 *    Lean on `idx_requests_turn` and `idx_turns_session_seq`, keep the per-turn
 *    query bounded by turn rather than scanning the session, paginate the turn
 *    list, and report at least one MEASURED timing with its row count rather than
 *    asserting it is fast.
 */

export function listSessionTurns(
  _db: Driver,
  sessionId: string,
  _opts: { limit: number; cursor?: string },
): TurnList {
  return { sessionId, items: [], nextCursor: null }; // TODO(C5)
}

export function getTurnDetail(_db: Driver, _turnId: string): TurnDetail | null {
  return null; // TODO(C5)
}
