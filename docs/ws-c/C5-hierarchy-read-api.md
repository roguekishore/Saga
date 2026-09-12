# C5 — Hierarchy read API

*Runs after C0. Parallel with C1–C4, C6. Read `docs/ws-c/README.md` and C0's
report first — C0 froze the response shapes you implement.*

## Why this exists

C6 renders a tree; you serve it. The shape:

```
project → conversation → human message → the requests it triggered → injection tags
```

The point is not session browsing. It is to make context injection legible: for
each thing the user typed, show the stream of back-and-forth it caused and exactly
what was injected into each step.

## You own (exclusive write)

```
packages/api/src/hierarchy.ts
packages/api/test/hierarchy.test.ts
```

`server.ts`, `readapi.ts`, and `queries.ts` are **not yours**. C0 froze the
response schemas and added the route; follow them exactly. If a frozen shape cannot
express something true, that is a message back to C0's owner — not a quiet
divergence, and not a field you add on your own.

## What to serve

Three levels, following the existing `queries.ts` conventions for pagination,
cursors, and null handling:

**A session's turns.** Ordered by `seq`. Each turn carries its wall-clock span,
`request_count`, `boundary_source`, and a rolled-up usage/timing summary.

**A turn's exchanges.** One row per request in the turn, in order. Each is one
harness→model round-trip. Per exchange: the label inputs (`harness`, `model`),
`call_role` + `call_role_source`, `routing_tier`, timing, usage, `stop_reason`,
what the model replied with (text or tool call), and its injection tags.

**A turn's injection tags.** From the `injections` table, carrying `source`
(`conduit-declared` vs `saga-observed`) so C6 can distinguish what CONDUIT told us
from what SAGA saw itself.

Read through the **readonly connection**. The collector opens a separate readonly
handle for reads precisely so WAL lets them proceed while the writer writes; that
is also the isolation the SQL endpoint requires. Do not write from this module —
not a cache table, not a lazy rollup.

## Provenance must survive to the UI

The rule holds end to end: every token and cost figure carries a source, and a
number with no source is a bug rather than a default.

Use `UsageValue` for single requests and **`AggUsage` for rollups**. `AggUsage`
carries `sources: Provenance[]` for exactly this situation — a turn can mix a
`gateway-computed` request with an `upstream-reported` one, and the UI needs to say
"12.4k tokens (gateway-computed)" or "mixed sources" honestly. Do not average
provenance away, and do not pick one source to represent the group.

**Null is never 0.** `cacheRead`/`cacheWrite` are null on some doors because
nothing produces them; `credits` is null on the entire Gemini feed because Vertex
bills GCP-side. Those render "n/a". A `COALESCE(..., 0)` in a rollup turns "we do
not know" into "it was zero," which is a lie the UI cannot detect. Sum what
exists, and report how many rows contributed.

## Timing is real today

Wall-clock is SAGA's own measurement, not a provider claim — `latency_ms` and
`ttft_ms` are measured at the proxy. So the timing rollup per turn is trustworthy
now, before any of the metrics plumbing fills in. Serve it: turn span, per-exchange
latency and TTFT, and where time actually went across the loop. This is the part of
the hierarchy that is fully real on day one, and it is worth being the strongest
thing in the response.

## `context_usage_percentage` climbs — that is the feature

Kiro returns it on **every** response, so one instruction yields N readings that
rise across the turn as the re-shipped conversation grows. That is not duplication
and not a bug; it is the agentic loop made visible, and the count of readings is
the number of round-trips the instruction took.

Serve the readings **in order, unaggregated**, alongside the count. Averaging them
destroys the only interesting thing about them.

## Performance — two measured facts from this codebase

Both are documented in the source and both apply to you:

- Raw `GROUP BY` over 912k requests measured **550–700ms against a 200ms target**,
  which is why `stats_daily` exists as a materialized rollup rather than a second
  query engine.
- `/api/storage` measured **~285ms uncached** and took a 20s TTL cache because it
  feeds a 15s dashboard poll.

Your queries hang off a hierarchy that grows without bound. Lean on the indexes C0
created (`turns(session_id, seq)`, `requests(turn_id)`, `requests(door, ts)`,
`injections(type)`), keep the per-turn query bounded by turn rather than scanning
the session, and paginate the turn list. Measure at least one query against a
realistic row count and report the number — do not assert it is fast.

If you find you want a cache or a rollup table, **stop and report it** rather than
adding one. A materialized rollup is a write, and the single-writer invariant is
C0's.

## The two-feed rule shows up in your rollups

Metrics reach SAGA two ways: the CONDUIT seam for Kiro-routed traffic (Door A) and
SAGA's own native parse for Gemini (Door B). Consequences for you:

- Surface `metrics_source` so a reader knows which feed a number came from.
- A Door A row with **no seam payload yet** (`ingest_received_at` null) is the
  normal state until CONDUIT ships. Serve it as "pending," clearly distinct from
  "zero" and from "will never have one."
- A Gemini row will **never** have a seam payload or a credit figure. That is by
  design, not missing data, and the two cases must not look alike in the response.

## Reserved columns stay reserved

`project_id` and `forge_run_id` are null and their contracts come separately. You
may expose them as nullable pass-throughs; do **not** build project or Forge-run
grouping, and do not invent a synthetic project from a workspace path.

## Tests

Follow the existing `packages/api/test/` layout. Cover at minimum:

- A session with three turns returns them in `seq` order with correct
  `request_count`.
- A turn's exchanges come back in order, each with its label inputs and tags.
- **Mixed provenance in one turn yields `AggUsage.sources` with both entries** —
  not one, not averaged.
- Null `credits` and null cache counters stay null through a rollup. Assert this
  directly; it is the failure most likely to be introduced later by a well-meaning
  `COALESCE`.
- `context_usage_percentage` readings come back ordered and unaggregated.
- A Door A row awaiting ingest reads "pending"; a Gemini row reads "not
  applicable." They are distinguishable.
- An empty session, a turn with one exchange, and a turn still open all behave.
- No write occurs against the readonly handle.

## Verification

The four gates in the README, all clean.

## Report

1. The endpoints and response shapes as implemented, and confirmation they match
   what C0 froze.
2. The query plan for the per-turn path and at least one **measured** timing with
   the row count it ran against.
3. How provenance survives aggregation, with the mixed-source case spelled out.
4. How "pending seam payload," "not applicable," and "zero" are told apart.
5. Anything you needed that the frozen shapes could not express.
