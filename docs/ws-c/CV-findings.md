# CV — Findings: Claude Code utility calls DO carry the main session id

*Read-only probe against `storage/saga.db`, run 2026-09-12. Answers the question
`CV-probe.md` posed. **C3 must read this before designing `call_role`.***

## 1. The answer: YES

Claude Code's internal utility calls carry the **same**
`metadata.user_id.session_id` as the conversation that spawned them.

Of 279 requests matching the utility fingerprint (no tools + `max_tokens` ≤ 64),
**279 carried a stated session id, and all 279 shared that id with a
tool-carrying main call in the same session.** Zero exceptions, across 4 distinct
sessions.

**Consequence for C3: take the cheap path.** Utility calls fold through the
existing client-declared-session path. No time+workspace fallback join, no
collision risk to manage, and **no extra schema column** — which is why this had
to be settled before C0 froze the single migration. It did not need one.

## 2. Evidence

Corpus: **1,082 requests, 15 sessions**, all captured
**2026-09-04T07:39Z – 18:46Z**.

The headline query:

```sql
WITH util AS (
  SELECT json_extract(json_extract(params_json,'$.metadata.user_id'),'$.session_id') AS sid
    FROM requests
   WHERE tools_json = '[]'
     AND CAST(json_extract(params_json,'$.max_tokens') AS INTEGER) <= 64
     AND json_extract(json_extract(params_json,'$.metadata.user_id'),'$.session_id') IS NOT NULL
), main AS (
  SELECT DISTINCT json_extract(json_extract(params_json,'$.metadata.user_id'),'$.session_id') AS sid
    FROM requests WHERE tools_json <> '[]'
)
SELECT COUNT(*) AS util_calls,
       SUM(CASE WHEN u.sid IN (SELECT sid FROM main) THEN 1 ELSE 0 END) AS sid_matches_a_main_call
  FROM util u;
-- → util_calls: 279, sid_matches_a_main_call: 279
```

Supporting counts:

| Measure | Value |
|---|---|
| Requests with a stated session id | 1,058 / 1,082 |
| The 24 without | 13 `/api/hello` + 9 `count_tokens` (both passthrough), 2 `/v1/messages` with null model |
| Most recent 500 requests, stated id | 498 / 500 |
| Sessions by source | 6 `client-declared`, 9 `inferred` |

The 24 exceptions are not counter-examples: `count_tokens` and the test endpoint
are not conversation traffic, and the existing adapter deliberately returns null
rather than inventing an id on an unrecognized route.

Per-session, utility and main traffic land on the **same session row**:

| session | utility calls | main (with tools) | models |
|---|---|---|---|
| `ses_9a07445e…` | 249 | 708 | opus-5, sonnet-5, haiku-4-5 |
| `ses_595d6fa3…` | 17 | 32 | opus-5, sonnet-5, haiku-4-5 |
| `ses_5c104ca6…` | 12 | 27 | opus-5, sonnet-5 |
| `ses_49ffff08…` | 1 | 2 | sonnet-5, haiku-4-5 |

## 3. Two corrections to the handoff — C3 must not implement the signal as written

### 3a. "Sonnet under an Opus session ⇒ subagent" is REFUTED as stated

The handoff calls this "a reliable subagent signal." In this corpus it would
**mislabel 278 of 395 Sonnet calls**, because the utility traffic *is* Sonnet
running under Opus sessions:

| Sonnet-5 calls | tools | budget | n |
|---|---|---|---|
| | no tools | ≤ 64 | **278** |
| | has tools | large | 117 |
| | no tools | small | 1 |

Model tier alone does not separate subagent from utility. What does is **tools +
budget**:

- **Sonnet WITH tools under an Opus session** → subagent candidate (108, 5, and 1
  per session across the three Opus sessions).
- **Sonnet with no tools and a tiny budget** → utility.

So the signal survives only in its refined form: *a Sonnet request under an
otherwise-Opus session that **carries tools and a real budget*** is a subagent
candidate. Use it that way, and label it `inferred` — it is a fingerprint, not a
declaration. Sonnet-with-tools was never *verified* to be a subagent here (nothing
on the wire says so); what is verified is that the naive form is wrong.

### 3b. "Tiny prompt" is the wrong half of the utility fingerprint

The spec's fingerprint reads "tiny prompt + no tools + small budget + cheap
model." Two of those four do not hold:

- **Utility payloads are LARGE.** Mean `request_bytes` for utility calls is
  **217 KB** (min 993 B, max 539 KB) versus 285 KB for everything else. That is
  expected on reflection: a titling call ships the conversation it must summarize.
  Keying on prompt size would miss nearly all of them.
- **"Cheap model" is relative.** Utility here runs on Sonnet-5 under Opus-5
  sessions, not on Haiku. And Haiku appears with `max_tokens` 32,000 and no tools
  (7 calls), which is *not* utility.

What actually discriminates cleanly:

```
tools_json = '[]'  AND  max_tokens <= 64  AND  message_count <= 3
```

Utility calls sit at `message_count` 2–3 (range across all 279: min 2, max 3);
everything else spans 0–455. That triple is the fingerprint C3 should build on,
and each component is structural rather than a size guess.

## 4. Honest limits of this result

State these rather than over-reading the finding:

- **One day, not weeks.** The corpus spans ~11 hours on 2026-09-04, captured by an
  older SAGA build. The `session_id` behavior is consistent across all of it and
  holds on the most recent rows, but this is not a longitudinal result.
- **Claude Code only.** Every request is `/v1/messages`, `/api/hello`, or
  `count_tokens`. There is **no Codex and no Gemini traffic**, so this says nothing
  about those harnesses — which is fine, since Codex declares its roles outright
  and Gemini's Vertex wire declares nothing either way.
- **Fingerprint-identified, not label-identified.** Nothing on the wire says
  "this is a titling call." The 279 are identified by shape, so the claim is
  "requests matching the utility shape share the main session id," not "every
  titling call ever does."
- **Model ids differ from `PLATFORM-FINDINGS` §5a-ter.** The wire here carries
  `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`; that document's
  catalogue (extracted from an older `kiro-cli.exe`) lists `claude-opus-4.7` and
  similar. Not load-bearing for WS-C, but do not hard-code either list.

## 5. What C3 should do

1. Fold utility calls through the **client-declared session path**. Nothing extra.
2. Classify `utility` on `no tools + max_tokens ≤ 64 + message_count ≤ 3`, not on
   prompt size or model tier.
3. Use Sonnet-under-Opus **only** in its refined, tools-carrying form, labeled
   `inferred`, with the reason recorded in `evidence`.
4. Put the discriminator in `evidence` so a reader can check the label rather
   than trust it — e.g. `["no-tools", "max_tokens<=64", "message_count=2"]`.
