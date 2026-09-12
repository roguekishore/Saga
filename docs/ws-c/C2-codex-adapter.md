# C2 — Codex adapter (`/v1/responses`, Door A)

*Runs after C0. Parallel with C1, C3–C6. Read `docs/ws-c/README.md` and C0's
report first. Wire detail: `D:/PROJECTS/AI/analysis/FINDINGS-codex.md`.*

## Why this exists

Codex is the **best case** of the three harnesses: it declares its session, its
conversation, and its turn boundaries on the wire, and it declares `call_role`
too. Where Claude Code needs a heuristic and Gemini needs SAGA to synthesize one,
Codex needs neither — `GROUP BY turn_id` is exact.

That makes this adapter's job mostly transcription. The risk is not difficulty,
it is reading the wrong field and silently mis-grouping everything.

## You own (exclusive write)

```
packages/adapters/src/codex-responses.ts
packages/adapters/test/codex-responses.test.ts
```

C0 created the stub and registered it. **This is not the existing `openai.ts`
adapter** — that one handles `/v1/chat/completions`, a different endpoint with a
different body shape. Do not edit it, and do not try to generalize it to cover
both.

## THE trap — session id is in the BODY, not the header

Codex sends a **`session-id` header. It is not the session.** It is the
prompt-cache key (FINDINGS-codex §1.4, §2.2, confirmed against a source comment
in Codex itself). Keying sessions on it will group unrelated conversations and
split real ones, and it will look plausible while doing so.

The real identity lives in `client_metadata` in the request body:

| Body field | Meaning | Fills |
|---|---|---|
| `client_metadata.session_id` | the session | `harness_session_id`, `clientSessionId` |
| `client_metadata.thread_id` | the conversation | `harness_thread_id` |
| `client_metadata.turn_id` | one instruction's agentic loop | `harness_turn_id` |
| `parent_thread_id` / `parent_turn_id` | the fold for subagents | `parent_turn_id` |

Read them from the body. Ignore the header for identity purposes entirely.

C0 extended `NormalizedRequest` with a `harnessIdentity` block for exactly this —
surface the values there, verbatim, alongside `clientSessionId`. Do not
reformat, prefix, or normalize the ids; they are wire evidence and downstream
code treats them as ground truth.

## Detection

Match on **endpoint: `POST …/responses`**. That is the reliable discriminator.

`originator: codex_cli_rs` confirms Codex when present, but it is **only sent when
non-default** — so treat it as corroboration, never as a requirement.
**Absence is not evidence of not-Codex.** A `matches()` that requires it will drop
real traffic to `passthrough`.

Register more specific than `passthrough` (C0 handled ordering). Make sure you do
not also match `/v1/chat/completions` or `/v1/messages`.

## Body shape — Responses API, not Chat Completions

The Responses shape uses `input[]` items rather than `messages[]`, with
`instructions` for the system prompt. Items are typed, and the types you must
handle:

- `message` — ordinary turn, has a `role`.
- `function_call` — a tool call from the model.
- `function_call_output` — a tool result. **Top-level item**, unlike Gemini's
  nesting inside a `Content`. Normalize as a tool turn.
- `reasoning` — may carry `encrypted_content`. See below.

Map these onto the existing `NormalizedRequest`/`ContentBlock` vocabulary
(`tool_use`, `tool_result`, `thinking`, `redacted_thinking`, `text`) rather than
inventing block types. `redacted_thinking` is the right home for encrypted
reasoning: the block exists precisely for reasoning SAGA cannot read.

`normalizeRequest` must never throw on a weird shape — that is a hard requirement
of the `Adapter` contract, and the capture layer only catches it as a last resort.

## Response stream

Codex **has** a terminal sentinel: `response.completed`. That is the opposite of
Gemini's situation (C1 has to synthesize one). Set your completion flag off it, the
way the existing observers do.

Provenance on this door is `gateway-computed` — the upstream is CONDUIT, not
OpenAI. Take `usageSource` from `AdapterOptions`; C0 wired the per-door chain to
supply the right value. Do not hard-code it, and do not report
`upstream-reported` for anything on Door A.

Real metrics for this traffic arrive later through the CONDUIT seam (C4), not from
you. Read whatever usage the stream does carry into the `Usage` slots, correctly
labeled — C0's writer resolves the two feeds by provenance rank, so an honest
`gateway-computed` number here is exactly right and will not clobber the real one.

## `routing_tier`

`service_tier` ∈ {`priority`, `flex`} (FINDINGS-codex §1.2). Surface it for
`requests.routing_tier`. It is a cost/latency dimension **both feeds carry** —
Gemini's Vertex request-type header is its analogue — and it matters to the
benchmarking thesis, since identical token counts can cost and latch differently
by tier.

## `call_role` is declared, not inferred — for this harness only

Codex states it. The signal is `x-openai-subagent` (header/metadata) ∈
{`review`, `compact`, `memory_consolidation`, `collab_spawn`, custom}, with
`parent_thread_id` / `parent_turn_id` giving the fold:

| Value | `call_role` |
|---|---|
| absent | `main` |
| `compact`, `memory_consolidation` | `utility` |
| anything else | `subagent` |

Surface the raw value; **C3 owns the mapping** and writes it with
`call_role_source: 'harness-declared'`. Do not implement `classifyCallRole`
yourself — it is C3's file, and C3 has to reconcile three harnesses.

This says nothing about Claude Code's utility calls. Different harness, different
question, settled separately by the CV probe.

## Injection tags

Present on the front door before any gateway, so SAGA sees them directly. Emit for
the `injections` table with `source: 'saga-observed'`:

- `user_instructions`
- `environment_context`
- **`environment_context:diff`** — a *partial* per-turn context block. **Surface
  this loudly.** It means "what the model knew" is spread across several requests
  rather than contained in one, which changes how a reader must interpret any
  single request in the turn. Do not let it render as just another quiet tag.
- `responses_lite_prefix`
- `reasoning_encrypted`
- `compaction`

## The turn-classification trap

"Last item has role `user` → human turn" **misfires here**, same as on Gemini: the
pushed context block is also a `role:"user"` item. Discriminate on the
`<user_instructions>` / `<environment_context>` markers before classifying.

Codex is the harder of the two trap cases — Gemini's block is always history item
0 at a stable position, Codex's is not. But it also matters least here, because
Codex *declares* `turn_id`, so C3 should never need the heuristic for this
harness. Your job is to expose the markers and the declared ids so C3 can prefer
evidence over inference. Do not classify.

## Tests

Follow the existing adapter test layout. Cover at minimum:

- A real-shaped `/v1/responses` request normalizes without throwing.
- **`client_metadata.session_id` is read from the body, and the `session-id`
  header is NOT used as the session.** Write this test so it fails loudly if
  someone later "simplifies" it to the header — include a case where the two
  differ.
- `function_call_output` normalizes as a tool result, not a user message.
- `reasoning` with `encrypted_content` lands as `redacted_thinking`.
- `response.completed` marks completion; a stream cut before it does not.
- `matches()` accepts `/v1/responses`, rejects `/v1/chat/completions` and
  `/v1/messages`, and **still matches when `originator` is absent**.
- `service_tier` surfaces for both `priority` and `flex`.
- Malformed bodies do not throw.

## Verification

The four gates in the README, all clean.

## Report

1. The detection predicate, and confirmation it matches without `originator`.
2. The identity fields as read, with explicit confirmation the header was not used.
3. How the four item types map onto existing block types.
4. The raw `call_role` signal you surface, and its shape for C3.
5. Injection tags emitted, with a note on how `environment_context:diff` is
   distinguished.
6. Anything in `FINDINGS-codex.md` that contradicts this spec — it is the more
   authoritative document on wire detail, and if it disagrees, say so rather than
   following me.
