# C3 — Turn grouping, `call_role`, and the Claude Code adapter

*Runs after C0 and after CV's report. Parallel with C1, C2, C4–C6. Read
`docs/ws-c/README.md`, C0's report, and `CV-probe.md`'s report first.*

## Why this exists

This is the rung the whole hierarchy rests on: **one human-typed message is not
one model call.** It opens an agentic loop — the model calls a tool, the harness
runs it and feeds the result back, repeat until the model answers with no tool
call. A small task is ~4 requests; a large one 30+. Every request re-ships the
entire growing conversation, because the model remembers nothing on its own.

So the natural grouping is: **a human message opens a turn; every loop round-trip
folds under it; the next human message opens the next turn.** Your job is to
decide, per request, which of those it is — and to do it across three harnesses
that declare wildly different amounts.

## You own (exclusive write)

```
packages/capture/src/turns.ts
packages/capture/src/call-role.ts
packages/adapters/src/anthropic.ts
packages/capture/test/turns.test.ts
packages/capture/test/call-role.test.ts
```

`proxy.ts` and `session.ts` are **C0's**. If you need a call-site change there,
that is a message back to C0's owner, not an edit.

## Prefer evidence over inference, per harness

The single most important design rule here. The three harnesses are not
equivalent and must not be flattened onto the lowest common denominator:

| Harness | Turn boundary | What you do |
|---|---|---|
| **Codex** | declares `turn_id` | **Use it.** `source: 'harness-declared'`. No heuristic. |
| **Claude Code** | declares nothing | Infer from structure. `source: 'inferred'`. |
| **Gemini** | declares nothing | Infer from structure. `source: 'inferred'`. |

Codex's declared id makes turn grouping exact for that harness — `GROUP BY
turn_id`. Never override a declared boundary with your heuristic, and never let a
refactor collapse the two paths into one "simpler" inferred path. `boundary_source`
exists so the UI can tell a reader which rows are evidence; a heuristic result
mislabeled as declared is worse than no grouping at all.

## The trap that will bite you

**"Last message has role `user` → human turn" is WRONG on both Codex and Gemini.**
The pushed context block is *also* a `role:"user"` item. Classify on markers
first, role second:

- **Codex**: `<user_instructions>` / `<environment_context>` markers.
- **Gemini**: `<session_context>` marker — and it is always history item 0 with a
  stable id, so position alone identifies it.
- **Claude Code**: see below — the discriminator here is structural and stronger.

C1 and C2 expose these markers from their adapters. You consume them.

## Claude Code: the structural discriminator

For Claude Code the distinction is real wire structure, not a marker hunt. A
tool-result round-trip's final message consists **solely of `tool_result`
blocks**; a human turn's does not.

`shared.ts` already computes exactly this as `toolOnly` —
`blocks.every(b => b.type === 'tool_result')` — and feeds it to
`structuralContextSource`, which is documented as derived from position rather
than guessed. That is your signal, and it is why `contextSourceInferred` stays
false for it.

Two consequences worth stating plainly:

- This is **structural** evidence, not a guess about intent. But it is still not
  *harness-declared*, so `boundary_source` is `'inferred'`. The distinction is
  between "SAGA derived this from the payload's shape" and "the harness told us."
  Record it honestly; do not promote it.
- **Compaction** writes a distinct record type and is distinguishable without
  reading content. It must not be mistaken for a human turn — a compaction event
  opening a new turn would split one instruction's loop in half.

## Turn grouping needs state — and C0 froze a pure function

`classifyTurn` as C0 froze it is pure: it answers "is this request a human turn or
a continuation?" It cannot, by itself, assign a `turn_id` to a continuation,
because that requires knowing **which turn is currently open for this session.**

So `turns.ts` needs a stateful correlator alongside the pure classifier, modeled
on the two that already exist:

```ts
export class TurnCorrelator {
  constructor(makeId: () => string, idleMs?: number);
  assign(input: {
    sessionId: string;
    classification: TurnClassification;
    ts: number;
  }): { turnId: string; seq: number; opened: boolean };
}
```

`SessionCorrelator` and `AgentCorrelator` are the pattern to follow — including
the bounded-map hygiene. `SessionCorrelator` prunes idle entries above 500 keys
because it is otherwise unbounded: one entry per distinct key, never revisited
once a conversation ends. Yours has the same shape and needs the same guard.

Rules for `assign`:

- A `human_turn` closes the open turn (if any) and opens a new one with `seq + 1`.
- A `tool_continuation` folds into the open turn and increments its
  `request_count`.
- A continuation arriving with **no open turn** — SAGA restarted mid-loop, or
  capture began mid-conversation — must not throw and must not silently invent a
  human turn. Open a turn marked as such so the UI can say "this turn began before
  SAGA was watching." An honest partial turn beats a fabricated complete one.
- A declared `harnessTurnId` keys the turn directly; the idle window is only for
  inferred boundaries.

**C0 wired the call site for `classifyTurn` only.** Check whether it accommodates
the correlator; if not, that is a message back to C0's owner. Say so in your report
either way — this is the one seam in WS-C I expect to need a second pass.

## `call_role` — main / subagent / utility

Three roles, and again: declared where possible.

**Codex declares it.** C2 surfaces the raw `x-openai-subagent` value; you map it,
with `call_role_source: 'harness-declared'`:

| Signal | Role |
|---|---|
| header absent | `main` |
| `compact`, `memory_consolidation` | `utility` |
| anything else (`review`, `collab_spawn`, custom) | `subagent` |

**Claude Code and Gemini need fingerprints**, `source: 'inferred'`:

| Role | Fingerprint |
|---|---|
| `main` | big system prompt + full tool set + long run |
| `subagent` | a *different* large prompt overlapping a main call in time |
| `utility` | tiny prompt + no tools + small token budget + cheap model |

**⚠️ CV ran, and it corrected both of these. Read `docs/ws-c/CV-findings.md`
before you write a line of `call-role.ts`.** Two things above are wrong as
written:

- **"Tiny prompt" is the wrong half of the utility fingerprint.** Utility payloads
  are LARGE (mean 217 KB) — a titling call ships the conversation it summarizes.
  The discriminator that actually works is
  `no tools + max_tokens ≤ 64 + message_count ≤ 3`.
- **The naive Sonnet-under-Opus rule is refuted.** It would mislabel 278 of 395
  Sonnet calls in real traffic, because the *utility* traffic is itself Sonnet
  under Opus sessions. It survives only in its refined form: Sonnet under an
  otherwise-Opus session **that carries tools and a real budget**. That is what
  `sessionModels` is for. Label it `inferred` — it is a fingerprint, not a
  declaration.

The good news from CV: utility calls **do** carry the main conversation's
`session_id` (279/279, zero exceptions), so they fold through the existing
client-declared path with no fallback join and no extra column.

Gemini's `call_role` is **not inferrable from the Vertex wire** at all. Return
`'unknown'` rather than guessing. `'unknown'` is a legitimate, honest answer here
and the schema has a slot for it.

### The utility-call fold depends on CV

Utility calls must fold into the enclosing conversation, not appear as
conversations of their own. **How** depends on CV's answer:

- **CV says yes** (utility calls carry the main `session_id`) — they fold through
  the existing client-declared-session path. `call_role` is then purely
  classification. Cheap; nothing extra needed.
- **CV says no** — they need a time + workspace + client fallback join. That is a
  heuristic: label it `inferred`, and respect the collision risk CV characterized.
  Two Claude Code windows open in different projects is the case that breaks a
  naive time join.
- **CV says the corpus cannot say** — implement the classification, leave the fold
  to the client-declared path, and report the gap. Do **not** build a speculative
  fallback against a question nobody has answered.

Do not re-run CV's queries. Read its report and follow it.

## `evidence: string[]`

Both classifications carry it, and it is not decoration. It records which markers
or fingerprints drove the decision, so a reader can see *why* a request was called
a subagent. C6 surfaces it. Populate it honestly — including when the answer is
`unknown`, where the evidence is what you looked for and did not find.

## The Claude Code adapter

You own `anthropic.ts`. It already reads `metadata.user_id.session_id` correctly
— that field is a JSON *string* holding an object, hence the double parse, and
only uuid-shaped values are accepted so a stray value cannot become a session key.
The sibling `device_id` is a stable device fingerprint that the redact layer
scrubs; **do not read it.**

Your changes are additive: surface `harnessIdentity` (session only — Claude Code
declares no thread or turn id), and expose whatever the turn classifier needs that
is not already there. Keep `clientSessionId` working exactly as it does; it is
load-bearing wire evidence and the existing comment explains why it survives
redaction by design.

## Tests

- A human turn opens a turn; three tool-result round-trips fold under it; the next
  human turn opens a new one with the right `seq`.
- Codex's declared `turn_id` wins over the heuristic, and lands
  `boundary_source: 'harness-declared'`.
- **The role-`user` trap**: a pushed context block with `role:"user"` does NOT
  open a turn, on both Codex and Gemini shapes.
- A tool-result-only final message classifies as continuation on Claude Code.
- A compaction record does not open a turn.
- A continuation with no open turn produces an honest partial turn, no throw.
- `call_role`: Codex's declared values map correctly; the Claude Code utility
  fingerprint classifies; Gemini returns `unknown`.
- Sonnet-under-Opus yields `subagent` — **only if CV confirmed it.**
- The correlator's bounded map prunes idle entries.

## Verification

The four gates in the README, all clean. The `tests/` latency and redaction gates
must stay green — your classifiers run in the capture path.

## Report

1. The turn-grouping design, per harness, and which paths are declared vs inferred.
2. Whether C0's call site accommodated `TurnCorrelator`, or what you need from C0.
3. The `call_role` fingerprints as implemented, and how CV's answer shaped the
   utility fold.
4. Whether the Sonnet-under-Opus signal is in use, and why.
5. What lands in `evidence` for each outcome, including `unknown`.
6. Any case where you could not honestly classify — name it rather than widening a
   heuristic to cover it.
