# C0 — Contracts, schema, hot path, write paths

*BLOCKING. Single owner, lands alone before C1–C6 start. Read
`docs/ws-c/README.md` first, then `CV-probe.md`'s report if it exists.*

## Why this is blocking

C1–C6 are six workstreams that would otherwise all edit `proxy.ts`,
`writer.ts`, `migrations.ts`, and `contracts/`. C0 makes every one of those a
finished, frozen surface, and creates a stub for each file the others own. After
C0 merges, no two remaining workstreams write the same file.

Your job is therefore **seams, not features**. Where a feature belongs to another
workstream, you create the stub with the exact signature and a `TODO(C3)`-style
marker, wire the call site, and stop. Resist implementing it.

## You own (exclusive write)

```
packages/contracts/src/{events,messages,readapi,index}.ts
packages/store/src/{migrations,writer}.ts
packages/capture/src/{proxy,session,index}.ts
packages/adapters/src/index.ts
packages/api/src/server.ts
apps/collector/src/collector.ts
```

Plus **stub creation only** for every file in the C1–C6 ownership rows.

## Three things the source contradicts in the handoff — verify, then fix

I read these in the code; confirm each before acting, and report what you find.

1. **`x-saga-request-id` is NOT forwarded upstream.** `proxy.ts:307` sets it on
   `respHeaders` — the response back to the *client*. The forwarded request
   headers (`fwdHeaders`, built at `:125-133`) never carry it. So CONDUIT cannot
   echo an id it never receives, and the seam's correlation channel is currently
   broken. The contract anticipated this: *"If SAGA does not currently forward
   that id to CONDUIT, WS-C adds it — one header."* **You add it.** Set it on
   `fwdHeaders` before the `fetch`, keep it on `respHeaders` too (clients may
   rely on it).

2. **`/ingest/conduit` would be swallowed by the static handler.**
   `server.ts:305` routes anything not starting with `/api` to `serveStatic`,
   which falls back to `index.html`. The contract froze the path as
   `/ingest/conduit` — outside `/api`. Left alone, CONDUIT's POST gets HTML and a
   200. Fix the routing order so the ingest path is matched before static.

3. **`messages.kind` has a CHECK constraint** — `IN ('message','raw_request')`
   (`migrations.ts:103`). Storing CONDUIT's rewritten-out payload as a message row
   requires extending it. Do that in the DDL, not with a later migration.

## Task 1 — Fresh schema, migration id 1

Discard the old DB; do not migrate it. Ship **one** migration, `id: 1`, name
`init`. The runner requires ids contiguous from 1 and throws if code and DB
history diverge (`migrate.ts:26-51`) — that throw is the desired behavior when
someone points the collector at the old file.

**No agent deletes a database file.** The operator moves `storage/saga.db*`
aside. Your job is to make the failure legible: catch the divergence throw in the
collector and log what happened and what to do about it.

Carry forward every existing table (`sessions`, `requests`, `messages`,
`request_messages`, `tool_uses`, `agents`, `messages_fts`, `meta`,
`stats_daily`), keeping the existing conventions: `STRICT` on every table,
`WITHOUT ROWID` on text-keyed ones, `messages` keeps its integer rowid because
FTS5 needs an integer doc id, `messages_fts` stays contentless. The reasoning for
each is documented at the top of the current `migrations.ts` — preserve those
comments where they still apply.

### New and reserved columns

Reserved means: create it, index it if it will be filtered on, leave it null.
Costs nothing now, avoids a migration later.

**`sessions`** gains:

| Column | Type | Meaning |
|---|---|---|
| `project_id` | TEXT | Reserved. Contract comes separately — **do not design it.** |
| `forge_run_id` | TEXT | Reserved. Forge is a later layer above conversation. |
| `door` | TEXT | `'A'` (→ CONDUIT) or `'B'` (→ Google). |
| `harness` | TEXT | `'claude-code'` / `'codex'` / `'gemini-cli'` / `'unknown'`. |
| `harness_session_id` | TEXT | Harness-declared session id, verbatim from the wire. |

**`turns`** — new table. A turn is one human-typed message plus every request it
triggered.

| Column | Type | Meaning |
|---|---|---|
| `turn_id` | TEXT PK | SAGA-minted (`turn_<ulid>`). |
| `session_id` | TEXT NOT NULL | FK → `sessions`. |
| `seq` | INTEGER NOT NULL | Ordinal within the session. |
| `started_at` / `ended_at` | INTEGER | Wall clock. `ended_at` null while open. |
| `boundary_source` | TEXT NOT NULL | `'harness-declared'` or `'inferred'`. |
| `harness_turn_id` | TEXT | Codex's `turn_id`. Null where the harness declares none. |
| `parent_turn_id` | TEXT | Reserved for subagent folding. |
| `request_count` | INTEGER NOT NULL DEFAULT 0 | Round-trips the instruction took. |

`boundary_source` is load-bearing: Codex declares turn boundaries and Claude Code
and Gemini do not. The UI must be able to say which rows are evidence.

**`requests`** gains:

| Column | Type | Meaning |
|---|---|---|
| `turn_id` | TEXT | FK → `turns`. Null until classified. |
| `call_role` | TEXT | `'main'` / `'subagent'` / `'utility'` / `'unknown'`. |
| `call_role_source` | TEXT | `'harness-declared'` (Codex) or `'inferred'`. |
| `door` | TEXT NOT NULL | `'A'` / `'B'`. |
| `harness` | TEXT | As on `sessions`. |
| `routing_tier` | TEXT | Codex `service_tier`; Gemini's Vertex request-type header. Cost/latency dimension both feeds carry. |
| `thought_tokens` | INTEGER | Reasoning, metered separately by Kiro. |
| `total_tokens` | INTEGER | |
| `credits` | REAL | Kiro `meteringEvent`. **Always null on the Gemini feed.** |
| `context_usage_percentage` | REAL | Climbs across a turn — the loop made visible. |
| `metrics_source` | TEXT | `'conduit-seam'` / `'gemini-native'` / null. |
| `harness_session_id`, `harness_thread_id`, `harness_turn_id`, `parent_turn_id` | TEXT | Harness-declared identity, verbatim. |
| `forge_run_id` | TEXT | Reserved. |
| `rewritten_out_msg_id` | INTEGER | FK → `messages(id)` ON DELETE SET NULL. |
| `ingest_received_at` | INTEGER | When the seam payload landed. Null = never arrived. |

On provenance: the existing four token columns each carry their own `_source`
because the observer fills them independently off the wire, where any one can be
absent. The seam-delivered set arrives as **one atomic object from one feed**, so
a row-level `metrics_source` is the honest encoding and avoids six near-identical
columns. Its enum also encodes the two-feed rule directly in the schema. Keep the
existing per-field `_source` columns exactly as they are.

**`reasoning_blocks`** — new. PK `(request_id, block_index)`, plus `model_id`
TEXT and `signature_present` INTEGER. Kiro carries a `modelId` per reasoning
block and it is worth storing.

**`injections`** — new. PK `(request_id, seq)`, plus `type` TEXT NOT NULL,
`location` TEXT, `source` TEXT NOT NULL (`'conduit-declared'` |
`'saga-observed'`), `detail` TEXT. Two sources because Door-A injections are
self-declared by CONDUIT while the harness-native ones (Codex
`user_instructions`, Gemini `session_context`) are visible to SAGA directly on
the front door.

**`messages.kind`** — extend the CHECK to include `'rewritten_request'`.

Index what will be filtered or joined: `turns(session_id, seq)`,
`requests(turn_id)`, `requests(call_role)`, `requests(door, ts)`,
`injections(type)`, and keep every existing index (including
`idx_requests_raw_msg`, which exists because retention's GC anti-joins on it and
was measured wedging for minutes without it).

## Task 2 — Two front doors, one store

Door A serves Claude Code (`/v1/messages`) and Codex (`/v1/responses`), both
upstream to CONDUIT. Door B serves Gemini, plain passthrough to Google, where
SAGA sees the real request and response itself.

`startProxy` currently takes one `upstream`. **Do not turn it into a router with
per-request upstream selection** — that puts branching in the hot path, which the
architecture explicitly forbids. Instead add `door: Door` to `ProxyOptions` and
have the collector call `startProxy` **twice**, on two ports with two upstreams.
One instance stays single-upstream; both keep the invariants unchanged.

- Door A: port 8787 (existing), upstream CONDUIT.
- Door B: new port, default 8789 (8788 is the API). Upstream
  `https://aiplatform.googleapis.com`. New env vars alongside the existing
  `SAGA_*` set, following `configFromEnv`'s pattern.

Stamp `door` onto `request_started` and persist it. Both doors emit into the
**same** bounded queue and the same single writer — one store, two doors.

Door B talks to a real external host over TLS, unlike Door A's loopback hop.
Confirm the existing `accept-encoding: identity` forwarding and the tee behave
against it; if something differs, report it rather than working around it
silently.

### Provenance is per-door, and one host is missing

`collector.ts:88-93` computes `usageSource` **once** for the whole process, by
asking whether the upstream host is one of `DEFAULT_PROVIDER_HOSTS`, then hands
that single value to `createAdapters`. Two doors break that assumption in both
directions:

- **Door A** upstream is CONDUIT — a gateway, not the provider. Numbers off it
  are `gateway-computed`. Correct today.
- **Door B** upstream is Google itself, so its numbers are `upstream-reported`.
  But `DEFAULT_PROVIDER_HOSTS` lists `generativelanguage.googleapis.com` and the
  Vertex door is **`aiplatform.googleapis.com`**, which is absent. Left alone,
  Door B would label Google's own lossless `usageMetadata` as gateway-computed —
  a provenance lie about the one feed whose counts are exact.

So: add `aiplatform.googleapis.com` to the list, and build a **separate adapter
chain per door** with that door's own `usageSource`, rather than one chain shared
by both. Verify the current behavior at those lines before changing it, and report
what you found.

## Task 3 — Hot path: the request id and the session correlator

**Forward `x-saga-request-id`** on `fwdHeaders` (see contradiction 1).

**Session synthesis for Gemini.** Extend `SessionCorrelator` — do not fork it.
Today it takes wire-stated ids when present and otherwise keys on
client+workspace/fingerprint with a 30-minute idle split. Gemini on the Vertex
door declares **nothing session-scoped**, so SAGA is the only component
positioned to stamp an id: it *is* the Gemini reverse proxy. Add a synthetic path
keyed on the install-scoped `x-gemini-api-privileged-user-id` (a machine
partition, not a session) plus the idle window. It is a guess, so it reports
`source: 'inferred'` and the UI says so. Keep the existing invariant that wire
evidence outranks a guess and never the reverse.

The note in the findings suggesting *CONDUIT* inject Gemini's id is wrong for
this architecture — Gemini never passes through CONDUIT.

**Call the classifier stubs** from the request-capture block, wrapped like every
other capture step so a throw cannot reach the forward path, and put their
results on `request_started`. The stubs return `'unknown'` until C3 lands; that
must be a working state, not a broken one.

## Task 4 — Contracts

**`events.ts`** — extend `RequestStartedSchema` with `door`, `harness`,
`routingTier`, a `turn` object (`turnId`, `kind`, `source`, `harnessTurnId`), a
`callRole` object (`role`, `source`), and `harnessIdentity` (`sessionId`,
`threadId`, `turnId`, `parentTurnId`). Follow the existing default-to-the-weaker-
claim discipline: `sessionIdSource` defaults to `'inferred'` deliberately, so an
emitter that forgets a field cannot accidentally assert wire truth. Do the same
for every new `*Source` field.

**`provenance.ts` — extend `Usage` to six counters.** Today it holds four
(`input`, `output`, `cacheRead`, `cacheWrite`), and `ObserverResult.usage` is
typed to it. Both new feeds carry more: Kiro meters `thoughtTokens` as its own
line item, and Gemini's `usageMetadata` carries six counters losslessly
(`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`,
`cachedContentTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`). Add
`thought` and `total` as nullable `UsageValue`s so an adapter can report what it
actually saw, and so the `thought_tokens` / `total_tokens` columns have a typed
path from wire to store. Keep every existing field name — this is additive, and
C1/C2/C4 all depend on it existing.

Gemini's `toolUsePromptTokenCount` has no home in the six and no analogue on the
Kiro feed. Do not invent a seventh slot for one provider: leave it in the adapter's
raw params and note the gap in your report.

Add one new event, **`conduit_ingest`**, carrying the frozen seam payload.

This is the most important design decision in C0: **C4's HTTP endpoint must not
write to SQLite.** `writer.ts` is the single writer, consuming a bounded queue.
The ingest endpoint therefore *pushes an event* and returns immediately — which
also satisfies the contract's fire-and-forget requirement for free. Spell this
out in the schema's doc comment so C4 cannot get it wrong.

**`readapi.ts`** — freeze the hierarchy shapes C5 implements and C6 renders:
a session's turn list, a turn's exchange list, and per-exchange labeling
(`[<harness> → <model>]`) with its injection tags. Every token figure stays a
`UsageValue`/`AggUsage` so provenance survives to the UI; every grouping and
classification carries its source. Add `hierarchy` and `ingestConduit` to
`API_PATHS`.

Additive changes only — the ReadAPI is what the dashboard codes against.

## Task 5 — Write paths

Extend `StoreWriter` for the new columns, the `turns` table, and the
`conduit_ingest` event. Keep the existing discipline exactly: dedup by content
hash, compress, never throw into the caller (a write failure increments a counter
and logs), and merge rather than overwrite on the finish path — the existing
redaction-hit merge exists because finishing must never erase what scrubbing
found.

**Metrics conflict resolution — rank by provenance, never by arrival order.** On
Door A two writers touch the same token columns: the observer (reading CONDUIT's
client-facing response, which carries CONDUIT's *estimates*) and the seam (real
Kiro `metadataEvent`/`meteringEvent` figures). Whichever lands second must not
simply win. Resolve on the provenance ladder that already exists —
`upstream-reported` > `gateway-computed` > `saga-estimated` — so the accurate
number survives regardless of ordering, and record which feed supplied the row in
`metrics_source`. A last-write-wins rule here would silently discard the real
numbers, which is the exact failure this workstream exists to prevent.

Store CONDUIT's `rewritten_out` as a `messages` row with kind
`'rewritten_request'`, pointed to by `requests.rewritten_out_msg_id`. This reuses
dedup and compression, and mirrors how `raw_request_msg_id` already works. The
seam payload is **redacted before storage** like everything else.

The join is on `request_id`. A payload may arrive for a request that does not
exist (SAGA restarted, id unknown) — handle it without throwing and count it.

## Task 6 — Stubs for C1–C6

Create each file in the C1–C6 ownership rows with its real exported signature, a
doc comment naming the owning workstream, and a working no-op return. Register
the Gemini and Codex adapters in `createAdapters` — **most specific first,
passthrough always last**, because every request must match something and nothing
may be dropped.

Freeze these two signatures exactly; C3 fills the bodies:

```ts
// packages/capture/src/turns.ts — implemented by C3
export type TurnBoundaryKind = 'human_turn' | 'tool_continuation' | 'unknown';
export type TurnBoundarySource = 'harness-declared' | 'inferred';

export interface TurnClassification {
  kind: TurnBoundaryKind;
  source: TurnBoundarySource;
  /** Harness-declared turn id where the wire carries one (Codex). Null otherwise. */
  harnessTurnId: string | null;
  /** Markers that drove the decision — for UI honesty and debugging. */
  evidence: string[];
}

export function classifyTurn(input: {
  request: NormalizedRequest;
  headers: Record<string, string>;
  adapterId: string;
  door: Door;
}): TurnClassification;
```

```ts
// packages/capture/src/call-role.ts — implemented by C3
export type CallRole = 'main' | 'subagent' | 'utility' | 'unknown';
export type CallRoleSource = 'harness-declared' | 'inferred';

export interface CallRoleClassification {
  role: CallRole;
  source: CallRoleSource;
  evidence: string[];
}

export function classifyCallRole(input: {
  request: NormalizedRequest;
  headers: Record<string, string>;
  adapterId: string;
  door: Door;
  sessionModels: string[];
}): CallRoleClassification;
```

`sessionModels` exists for one documented signal: a Sonnet request under an
otherwise-Opus session is a reliable subagent marker, because Claude Code drops
subagents to Sonnet by default. CV's report says whether real rows bear that out.

## Verification

The four gates in the README, all clean. Beyond them:

- The collector boots against a **fresh** DB, both doors listen, and a request
  through each lands a row with the right `door`.
- Pointing it at a stale DB fails with a legible message rather than a raw throw.
- The two invariants still hold. There is a latency gate and a redaction gate in
  `tests/` — they must stay green, and they are the tests most likely to catch a
  mistake in this workstream.

## Report

1. Confirmation or correction of the three contradictions, with file:line.
2. The full final schema, with the reserved columns called out.
3. Door A / Door B ports and env vars as shipped.
4. The frozen `conduit_ingest` event shape and the ReadAPI hierarchy shapes.
5. The stub list, so C1–C6 know exactly what exists.
6. Anything you had to decide that the spec left ambiguous — name it, so the
   other six inherit the decision instead of re-litigating it.
