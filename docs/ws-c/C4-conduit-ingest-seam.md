# C4 — The CONDUIT ingest seam (`/ingest/conduit`)

*Runs after C0. Parallel with C1–C3, C5–C6. Read `docs/ws-c/README.md`, C0's
report, and **`D:/PROJECTS/AI/CONTRACT-conduit-saga-seam.md`** — that contract is
frozen and outranks this spec if they ever disagree.*

## Why this exists

SAGA captures the **clean-in** request at its front door. Two things it cannot see,
and this seam supplies exactly those two:

1. **Real metrics** — they only exist after CONDUIT parses Kiro's response events.
2. **Rewritten-out payload** — the final Kiro-shaped request. The rewrite happens
   *inside* CONDUIT, invisible to a front-door proxy.

The diff (clean-in ⊖ rewritten-out) **is** the injection SAGA renders as tags.
This is the blind-spot fix: for a tool built to visualize context injection, the
largest injection in the chain is currently invisible.

You are building the plumbing now. The values arrive when CONDUIT (WS-B) ships.
A working endpoint that has never received a payload is a correct outcome for this
workstream.

## You own (exclusive write)

```
packages/api/src/ingest.ts
packages/api/test/ingest.test.ts
```

`server.ts` is **C0's** — it created the route and wired it to your handler. If the
wiring is wrong, that is a message back to C0's owner.

## The one rule that shapes the whole design

**Your endpoint must not write to SQLite.**

`StoreWriter` is the single writer, consuming a bounded queue. Your handler
validates the payload, pushes a `conduit_ingest` event (C0 froze the shape), and
returns. That is all.

This is not stylistic. It is what makes the contract's **fire-and-forget**
requirement free: the POST must never delay or fail the client response, and if it
did a synchronous DB write, a slow write would become CONDUIT's problem and
therefore the user's. Pushing to the queue makes the response immediate by
construction and keeps SAGA's single-writer invariant intact.

Return promptly with a small JSON acknowledgement. Never block on the store.

## Correlation, and the header C0 had to add

Every emit carries a `request_id` matching the one SAGA assigns at its front door.
CONDUIT reads SAGA's `x-saga-request-id` and echoes it back; that is how SAGA joins
the metrics and rewritten-out to the clean-in it already stored.

**That header was not being forwarded.** `proxy.ts` set it on the *response* to the
client but never on the request going upstream, so CONDUIT could not echo an id it
never received. C0 fixed it. **Verify it actually landed** before you trust the
join — the whole seam is inert if it did not, and it will fail silently rather than
loudly.

## Payload — schema v1, frozen

```jsonc
{
  "request_id": "req_...",          // matches SAGA front-door id
  "ts": 1234567890,
  "model_id": "claude-opus-4.7",    // resolved model actually sent to Kiro

  "metrics": {
    "input_tokens": 0, "output_tokens": 0,
    "thought_tokens": 0,            // reasoning, metered separately
    "cache_read_tokens": 0, "cache_write_tokens": 0, "total_tokens": 0,
    "credits": 0.0,                 // meteringEvent raw credit count
    "context_usage_percentage": 0.0,
    "stop_reason": "END_TURN",
    "reasoning_blocks": [ { "model_id": "…", "signature_present": true } ]
  },

  "rewritten_out": {
    "system_prompt": "…",
    "current_message": { },
    "history": [ ],
    "tools": [ ],
    "injections": [
      { "type": "thinking_tags", "location": "last_user_message" }
    ]
  }
}
```

Validate with zod against the contract shape. Reject a malformed body with a 400
and a message that says what was wrong — CONDUIT's author needs to debug against
this. Never throw out of the handler.

## Provenance — the seam's numbers are `upstream-reported`

Worth being precise, because it is the point of the whole seam. On Door A two
sources touch the same token columns:

- **The observer**, reading CONDUIT's client-facing response → CONDUIT's
  *estimates* → `gateway-computed`.
- **The seam**, carrying figures CONDUIT parsed from **Kiro's own**
  `metadataEvent`/`meteringEvent` → `upstream-reported`.

Kiro is the provider on this door, so the seam's numbers are upstream-reported and
therefore **outrank** the observer's under C0's provenance ladder
(`upstream-reported` > `gateway-computed` > `saga-estimated`). Label them correctly
and the conflict resolves itself regardless of which arrives first. Label them
wrong and the estimates win — which is the exact failure this apparatus exists to
prevent.

Set `metrics_source: 'conduit-seam'`.

## Redaction before storage

Non-negotiable, and easy to overlook here because the payload arrives over HTTP
rather than through the proxy's capture path. `rewritten_out` contains a full system
prompt, message history, and tool specs — the same material the proxy scrubs. Run
it through `@saga/redact` before it reaches the queue.

Do **not** add a raw capture mode. If the injection-tag view turns out to need
literal unredacted content, that is a separate security-weighted decision to raise,
not to assume.

## Injections

Store CONDUIT's self-declared `injections` with `source: 'conduit-declared'`.
CONDUIT knows what it did and declares it rather than making SAGA
reverse-engineer the diff.

SAGA **may** still diff clean-in against rewritten-out to verify, and the design
note calls the diff the ideal display — not a static tag list, but "here is your
message, and here is precisely what the gateway added, moved, and padded." Treat
the diff as an enhancement on top of the declared tags, not a prerequisite. If you
do not build it, say so; C6 renders whatever exists.

## Failure modes to handle without throwing

- **Unknown `request_id`** — SAGA restarted, or the front-door row was never
  stored. Count it, log it, drop the payload. This is expected, not exceptional.
- **Duplicate emit for one `request_id`** — must be idempotent. A retry must not
  double-count credits.
- **Oversized body** — `rewritten_out` can carry a full history and tool set. Cap
  it explicitly. There is precedent for both a cap and a limit in this codebase:
  the proxy caps buffered capture bodies, and the SQL endpoint caps its input.
  Pick a defensible ceiling, state it, and reject over it with a clear 413 or 400
  rather than letting an unbounded body into the queue.
- **SAGA down entirely** — CONDUIT drops the emit and logs; the client is
  unaffected. Nothing for you to build, but do not design anything that assumes
  CONDUIT will retry.

## Security — this is the first write endpoint on an unauthenticated server

The read API, WebSocket, and SQL endpoint have **no auth**; loopback binding is the
only boundary, and the SQL endpoint already runs arbitrary SQL. You are adding the
first endpoint that *writes*.

- Bind loopback explicitly. The contract says loopback only.
- Treat the body as untrusted input even though it comes from a local component.
  Validate, cap, and reject — do not assume a well-behaved caller.
- Do not widen the surface: one POST path, one payload shape, no query
  parameters, no echo of stored content back to the caller.

Say plainly in your report that this endpoint is unauthenticated and protected only
by loopback, so the decision is visible rather than buried.

## The two-feed rule

This seam carries **only Kiro-routed traffic** (Claude via Claude Code, Luna via
Codex). **Gemini never passes through CONDUIT** — SAGA parses Google's own response
natively on Door B (C1). So do not build anything here that assumes all metrics
arrive through this endpoint, and do not treat a Gemini request lacking a seam
payload as an error. It will never have one, by design.

Gemini also yields **no credits** — Vertex bills GCP-side. `credits` is non-null
only on this feed.

## Tests

- A valid v1 payload validates, pushes exactly one `conduit_ingest` event, and
  returns promptly.
- The handler performs **no** direct DB write. Assert this structurally, not by
  inspection — it is the invariant most likely to be broken by a later "fix."
- Malformed payload → 400, no event pushed, no throw.
- Unknown `request_id` → counted, no throw.
- Duplicate emit → idempotent; credits not double-counted.
- Oversized body → rejected at the cap.
- `rewritten_out` is redacted before reaching the queue.
- Metrics land labeled `upstream-reported` / `metrics_source: 'conduit-seam'`.

## Verification

The four gates in the README, all clean. The redaction gate in `tests/` is directly
relevant to you and must stay green.

## Report

1. Confirmation that `/ingest/conduit` matches the frozen contract field for field,
   or precisely where it deviates and why. **This is the headline the caller
   asked for.**
2. Confirmation that `x-saga-request-id` is forwarded upstream, verified not
   assumed.
3. Confirmation the handler does no direct DB write, and how the test enforces it.
4. The body cap you chose and the rejection behavior.
5. Whether you implemented the verification diff, or only store declared
   injections.
6. The explicit security note about an unauthenticated write endpoint.
