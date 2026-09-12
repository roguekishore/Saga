# C1 — Gemini adapter (Door B, Vertex only)

*Runs after C0. Parallel with C2–C6. Read `docs/ws-c/README.md` and C0's report
first. Wire detail: `D:/PROJECTS/AI/analysis/FINDINGS-gemini.md` — it is the
authoritative document on this door and outranks this spec on any wire fact.*

## Why this exists

Gemini is the **hard case** of the three harnesses and the handoff says to design
for it first, not last. On the Vertex door it declares no session id and no turn
boundary, and it never passes through CONDUIT — SAGA *is* its reverse proxy, so
SAGA is the only component that can see or stamp anything.

The compensation: this is the one feed whose token counts are **exact**. Google
returns six counters in `usageMetadata` and SAGA reads them straight off the wire.
No estimation, no seam, no gateway in the middle.

## You own (exclusive write)

```
packages/adapters/src/gemini.ts
packages/adapters/test/gemini.test.ts
```

C0 created the stub and registered it in `createAdapters`. `shared.ts` is
read-only — if you need a helper, put it in your own file.

## The deployment is fixed — read this before anything else

**Vertex / Agent Platform key, Door B only.** Ignore everything you may find
about a Door A path, CodeAssist, or `v1internal` — it does not occur in this
deployment. The door SAGA proxies is a plain, documented public API:

```
POST https://aiplatform.googleapis.com/v1beta1/publishers/google/models/{model}:streamGenerateContent?alt=sse
x-goog-api-key: <Agent Platform key>
```

Verified against the pinned SDK and Google's own docs (FINDINGS-gemini §1.10).

## Wire facts — authoritative

**Request body.** `{contents[], systemInstruction, tools[{functionDeclarations}],
generationConfig{thinkingConfig{includeThoughts, thinkingBudget}}}`.

The shape trap: **tool results are `functionResponse` parts nested inside a
`Content`**, not top-level items the way Anthropic and OpenAI put them. A
tool-result turn is a `Content` whose `parts` carry `functionResponse`. Get this
wrong and every tool round-trip normalizes as an ordinary user message, which
breaks C3's turn grouping downstream.

**Response stream.** SSE, colon-method, `alt=sse`. The critical difference from
every other adapter in the repo: **there is no terminal sentinel event.**
Anthropic sends `message_stop`, OpenAI sends `[DONE]`, Codex sends
`response.completed`. Gemini sends nothing — completion *is* the HTTP stream
ending. You must synthesize your own end-of-turn.

Consequence for the observer: do not wait for a frame that will never arrive.
`finalize()` is called by the capture layer when the stream ends
(`proxy.ts:474`), and for this adapter that call is the only completion signal you
get. Make sure a normal, successful stream does not look like a truncated one —
the existing observers set a `complete` flag off their sentinel, and you have no
sentinel to set it from.

**Usage — six counters, lossless.** Read `usageMetadata` **whole**:

| Wire field | Maps to |
|---|---|
| `promptTokenCount` | `usage.input` |
| `candidatesTokenCount` | `usage.output` |
| `totalTokenCount` | `usage.total` |
| `cachedContentTokenCount` | `usage.cacheRead` |
| `thoughtsTokenCount` | `usage.thought` |
| `toolUsePromptTokenCount` | no slot — see below |

C0 extended `Usage` to six counters, so `thought` and `total` have typed homes.
`toolUsePromptTokenCount` has no analogue on the Kiro feed and deliberately got no
slot; keep it in the adapter's raw params rather than forcing it somewhere. Note
in your report if that turns out to matter.

`usage.cacheWrite` stays null — nothing on this door reports it. **`credits`
stays null**: Vertex bills GCP-side and there is nothing on the wire (V23). Do not
estimate one.

Provenance is `upstream-reported` on this door because the upstream *is* the
provider. C0 wired the per-door adapter chain to hand you that; take
`usageSource` from `AdapterOptions` as every other adapter does and do not
hard-code it.

## Detection

Strongest signal is the **User-Agent**: `GeminiCLI/{version}/{model}`, or the
substring `proxy_client=geminicli` for the VS Code form. It is built before the
auth branch, so Vertex traffic reliably carries it.

Secondary, and what `matches()` should key on structurally: the
`publishers/google/models/…:streamGenerateContent` path plus `x-goog-api-key`.
Match on the path shape — the colon-method means the model id and the method share
a path segment, so a naive `endsWith` on a fixed string will not do it. Extract
the model id from that segment; it is also where `request.model` comes from, since
this API puts the model in the URL rather than the body.

Register more specific than `passthrough`, which C0 already handled. Be careful
not to match Door A traffic.

## Injection tags — visible on the front door, no seam needed

These are present before any gateway, so SAGA sees them directly. Emit them for
the `injections` table with `source: 'saga-observed'`:

- `session_context`
- `session_context:folder_tree`
- `history_hardening`
- `vertex_routing_tier` — from `X-Vertex-AI-LLM-Request-Type` /
  `-Shared-Request-Type`. This is Gemini's analogue of Codex's `service_tier`, and
  it also fills `requests.routing_tier`. It matters to the benchmarking thesis:
  the same tokens can cost and latch differently by tier.

The Door-A tags (`thought_rewritten`, `credits_consumed`) do **not** fire here.
Do not emit them.

## The turn-classification trap

"Last item has role `user` → human turn" **misfires on this harness.** The pushed
context block is *also* a `role:"user"` item. Discriminate by the
`<session_context>` marker before classifying.

Gemini is the easier of the two trap cases: that block is always **history item 0
with a stable id**, so position alone identifies it. Expose enough structure from
`normalizeRequest` for C3's `classifyTurn` to see it — the marker and the position.
Do not implement the classification yourself; that is C3's file.

## Session identity — you cannot fix this here

The Vertex door declares nothing session-scoped. All you have is
`x-gemini-api-privileged-user-id`, which is **install-scoped — a machine
partition, not a session.** Return `clientSessionId: null` and let C0's synthetic
path in `SessionCorrelator` do its job. Do not invent a session id in the adapter,
and do not pass the privileged-user-id off as one.

`call_role` is likewise not inferrable from this wire. Leave it to C3.

## Tests

Follow the existing adapter test layout in `packages/adapters/test/`. Cover at
minimum:

- A real-shaped streaming request/response pair normalizes without throwing.
- All six `usageMetadata` counters land in the right `Usage` slots, with
  `cacheWrite` and credits null.
- A tool-result turn (`functionResponse` inside a `Content`) normalizes as a tool
  turn, not a user message.
- A stream that ends with **no sentinel** finalizes as complete, not truncated.
- A truncated stream is still distinguishable from a clean one.
- `matches()` accepts the colon-method Vertex path and rejects Door A paths.
- Malformed and unexpected bodies do not throw — `normalizeRequest` must never
  throw on weird shapes, per the `Adapter` contract.

## Verification

The four gates in the README, all clean.

## Report

1. The detection predicate as shipped, and what it rejects.
2. Confirmation that all six counters are read, and where
   `toolUsePromptTokenCount` ended up.
3. How you synthesized end-of-turn without a sentinel, and how a clean stream is
   told apart from a truncated one.
4. The injection tags emitted, and the `routing_tier` header you actually read.
5. Anything about the Vertex door that contradicts this spec or C0's assumptions —
   particularly around TLS, compression, or the tee, which C0 flagged as unverified
   against a real external host.
