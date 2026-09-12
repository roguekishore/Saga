# CV — Probe: do Claude Code's utility calls carry the main session id?

*Read-only investigation. ~1 hour. Runs BEFORE C0 so C3 can finalize `call_role`
grouping. Read `docs/ws-c/README.md` first.*

## Why this exists

Claude Code fires internal helper calls to smaller models — conversation
titling, compaction, recap. On the wire they arrive as ordinary standalone
requests. SAGA must classify them `call_role = utility` and **fold them into the
enclosing conversation**, not display them as conversations of their own.

How they fold depends on one fact nobody has checked: **do those utility calls
carry the same `metadata.user_id.session_id` as the conversation that spawned
them?**

- **If yes** — they fold through the existing client-declared-session path.
  `call_role` is then purely a display/classification concern. Cheap.
- **If no** — they need a fallback join on time + workspace + client, which is a
  heuristic, must be labeled `inferred`, and needs its own column. Expensive.

C3 cannot finalize its grouping design without the answer, and the answer is
already sitting in captured traffic. Settle it before anyone writes code.

## What you must not do

- **Do not delete, move, or VACUUM any database file.** This is a read-only
  probe. Open SQLite **readonly**.
- Do not modify any source file. Your deliverable is a written answer.
- Do not echo secret values if you encounter them. The store is redacted, but
  `params_json` is provider-shaped — reference fields by name, not value.

## The data

`D:/PROJECTS/AI/SAGA/storage/saga.db` — ~198 MB, the pre-existing corpus. It is
scheduled for discard by C0, which makes it perfect for this: it costs nothing
and it is real traffic.

There is **no `sqlite3` CLI on this machine.** Query through Bun:

```ts
// probe.ts — run with: bun probe.ts
import { Database } from 'bun:sqlite';
const db = new Database('storage/saga.db', { readonly: true });
console.log(db.query('SELECT COUNT(*) AS n FROM requests').get());
```

Delete `probe.ts` when you are done.

## What to establish

Work in this order; stop early if the corpus cannot support a claim.

1. **Do utility calls exist in this corpus at all?** Find the fingerprint: a
   small model id, a short system prompt, no tools, a small `max_tokens`. The
   model column and `params_json` both help. Report the count and how you
   identified them — if there are none, say so plainly rather than reasoning from
   an empty set.

2. **The headline question.** For each candidate utility request, is
   `metadata.user_id.session_id` present in `params_json`, and does it equal the
   session id of a main-loop conversation that was active at the same time?
   `json_extract(json_extract(params_json, '$.metadata.user_id'), '$.session_id')`
   is the accessor already used in production code — the field is a JSON *string*
   holding an object, hence the double extract.

3. **If present and matching:** confirm it is not a coincidence. Do the
   timestamps sit inside a main conversation's span? Does the workspace agree?

4. **If absent or non-matching:** characterize what a fallback join would have to
   key on. How close in time is the nearest main-loop request? Is `client_name`
   or workspace distinct enough to disambiguate two concurrent conversations?
   State the collision risk honestly — two Claude Code windows open in different
   projects is the case that breaks a naive time join.

5. **Bonus, cheap while you are in there:** does a Sonnet request ever appear
   under an otherwise-Opus session? That is the documented subagent signal
   (Claude Code drops subagents to Sonnet by default) and C3 will use it. Confirm
   or refute against real rows.

## Interpreting what you find

Be careful with two traps:

- **Absence of evidence.** If no utility calls appear, the honest conclusion is
  "this corpus does not contain them," not "they do not carry session ids." Say
  which one you are claiming.
- **The corpus predates recent changes.** Rows here were captured over weeks by
  older SAGA builds. A field missing on old rows may be present on new traffic.
  Check whether your finding holds on the most recent rows specifically, and note
  the date range you actually examined.

## Report

State, in plain prose:

1. **The answer**: do Claude Code utility calls carry the main conversation's
   `session_id`? Yes / no / corpus cannot say.
2. The evidence — counts, the query you ran, the date range examined.
3. Which path C3 should take: client-declared fold, or time+workspace fallback.
   If fallback, the exact join keys and the collision risk.
4. The Sonnet-under-Opus subagent signal: confirmed, refuted, or not present.
5. Anything you noticed that contradicts `docs/ws-c/README.md` or the handoff.

This report goes straight into C3's design. Be specific enough that C3 does not
have to re-run your queries.
