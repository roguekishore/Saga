# WS-C — SAGA observability hierarchy: workstream index

*Written 2026-09-12. Splits `D:/PROJECTS/AI/HANDOFF-saga-build.md` into
independently-assignable specs. Source documents and their precedence are in the
table below — read it before the specs, since the documents live outside this
repo.*

## What WS-C is

Turn SAGA from a request-lister into the hierarchical measurement apparatus that
gates Forge:

```
project → conversation → human message → the requests it triggered → injection tags
```

SAGA is a local-first reverse proxy (Bun/TypeScript) that tees AI traffic into
SQLite with a React dashboard. Everything below builds on data SAGA already
captures, except the metrics half of C4, which is plumbing-now / values-later.

## Source documents — they live OUTSIDE this repo

These specs sit in the SAGA repo; every document they cite sits one level up, in
the ecosystem root. If your working directory is the SAGA repo, a relative path
will not find them. Use these absolute paths:

| Document | Path | What it settles |
|---|---|---|
| Seam contract | `D:/PROJECTS/AI/CONTRACT-conduit-saga-seam.md` | **Frozen.** The ingest interface. Outranks everything. |
| Handoff | `D:/PROJECTS/AI/HANDOFF-saga-build.md` | Scope: steps 1–8, reserved columns, the two rules. |
| Hierarchy design | `D:/PROJECTS/AI/FORGE/DESIGN-saga-observability-hierarchy.md` | Intent: the target tree, rung feasibility, the blind spot. |
| Platform findings | `D:/PROJECTS/AI/FORGE/PLATFORM-FINDINGS.md` | Mechanics. §5 (what SAGA can see), §5a-ter (Kiro field schema), §5a-quinquies (the agentic loop). |
| Codex wire detail | `D:/PROJECTS/AI/analysis/FINDINGS-codex.md` | Authoritative for C2. |
| Gemini wire detail | `D:/PROJECTS/AI/analysis/FINDINGS-gemini.md` | Authoritative for C1. |
| Workstream plan | `D:/PROJECTS/AI/PARALLEL-WORKSTREAMS.md` | Why WS-C exists and what gates Forge. |
| Design system | `packages/ui/DESIGN.md` (in-repo) | Binding for C6. |

**Precedence when they disagree:** seam contract > handoff > hierarchy design >
platform findings. For a pure wire fact about Codex or Gemini, the FINDINGS doc for
that harness outranks the spec you were handed — and if it contradicts your spec,
report it rather than quietly following either one.

## The ordering rule

**C0 lands first and alone. Then C1–C6 run in parallel. CV runs before C0.**

```
CV (probe, read-only, ~1h)
     │  answers one design question C3 needs
     ▼
C0  contracts + schema + hot path + write paths        ← BLOCKING, single owner
     │
     ├──> C1  Gemini door B adapter
     ├──> C2  Codex /v1/responses adapter
     ├──> C3  turn grouping + call_role + Claude Code adapter
     ├──> C4  CONDUIT ingest seam
     ├──> C5  hierarchy read API
     └──> C6  hierarchy UI
```

C0 is blocking because it freezes every seam the other six code against — the
event schema, the DDL, the read-API shape, and the stub module signatures. Once
C0 is merged, no two remaining workstreams write the same file.

**CV precedes C0, not just C3.** The obvious reading is that CV only matters to
C3's grouping design, so it could run in parallel. It cannot: if CV finds that
Claude Code's utility calls do *not* carry the main session id, they need a
fallback join, and recording that join honestly may need a column. C0 ships the
one and only migration — the entire "reserve columns now" discipline exists to
avoid a second one. So the cheap read-only probe lands first, while its answer is
still free.

## Ownership matrix — exclusive write lists

A workstream writes **only** the files in its row. Everything else it reads.
Any change needed outside your row is a message back, not an edit.

| WS | Owns (exclusive write) |
|---|---|
| **C0** | `packages/contracts/src/{events,messages,provenance,readapi,index}.ts`, `packages/store/src/{migrations,writer}.ts`, `packages/capture/src/{proxy,session,index}.ts`, `packages/adapters/src/index.ts`, `packages/api/src/server.ts`, `apps/collector/src/collector.ts`, `apps/web/src/main.tsx`, `apps/web/src/shell/AppShell.tsx`, plus **stub creation** of every file listed in C1–C6 rows |
| **C1** | `packages/adapters/src/gemini.ts`, `packages/adapters/test/gemini.test.ts` |
| **C2** | `packages/adapters/src/codex-responses.ts`, `packages/adapters/test/codex-responses.test.ts` |
| **C3** | `packages/capture/src/{turns,call-role}.ts`, `packages/adapters/src/anthropic.ts`, `packages/capture/test/{turns,call-role}.test.ts` |
| **C4** | `packages/api/src/ingest.ts`, `packages/api/test/ingest.test.ts` |
| **C5** | `packages/api/src/hierarchy.ts`, `packages/api/test/hierarchy.test.ts` |
| **C6** | `apps/web/src/pages/HierarchyPage.tsx`, `apps/web/src/components/{TurnTree,InjectionTags}.tsx`, `apps/web/src/lib/hierarchy-fixtures.ts` |

`packages/adapters/src/shared.ts` is read-only for everyone after C0. If C1 or C2
needs a new helper there, put it in your own file instead.

## Ground rules — all workstreams

1. **The two proxy invariants outrank every feature here.** Never block the
   response path; never let a capture failure propagate. `proxy.ts` documents both
   at the top with the Bun tee ground truth behind them. If your feature seems to
   need a blocking call in the hot path, you have the design wrong — say so.
2. **Redaction runs before storage.** Anything reaching the queue is already
   scrubbed. That includes CONDUIT's `rewritten_out` payload (C4). A raw capture
   mode is a separate, security-weighted decision — do not add one.
3. **No auth on the read API, WS, or SQL endpoint.** Loopback binding is the only
   boundary. C4 adds the first *write* endpoint on that server; treat that as the
   security-relevant change it is and bind loopback explicitly.
4. **Provenance is not optional.** Every token/cost number carries a source
   (`upstream-reported` / `gateway-computed` / `saga-estimated`). A number with no
   source is a bug. Null renders as "n/a" and is never coerced to 0.
5. **Wire evidence and inference are labeled differently, everywhere.** The
   existing `session_id_source` pattern (`client-declared` vs `inferred`) is the
   model. Every new grouping and classification column gets the same treatment,
   and the UI must be able to tell them apart.
6. **Discard the existing DB — do not migrate it.** C0 ships one fresh migration
   at id 1. **No agent deletes a database file.** The operator moves
   `storage/saga.db*` aside by hand; the collector's job is to fail loudly with a
   clear message if it finds divergent history.
7. **Do not build Forge grouping or design `project_id`.** Reserve the columns
   (`forge_run_id`, `call_role`, `project_id`); the contracts come separately.

## Verification — every workstream, before declaring done

```bash
npm install                            # once
pnpm -r typecheck                      # must exit clean
bun test packages apps tools tests     # must pass
npx biome check .                      # must report no errors
```

Bun is a hard runtime requirement, not a dev tool — `bun:sqlite` and `Bun.serve`
are load-bearing. There is no `sqlite3` CLI on this machine; query SQLite through
`bun` with `bun:sqlite`.

## Commits

Branch `feat/observability-hierarchy` already exists and carries these specs.
Conventional Commits, one logical change per commit, scope = the package you
touched:

```
feat(store): hierarchy schema with reserved metric and identity columns
feat(adapters): gemini vertex door with lossless usage metadata
```

Commit as you build rather than in one drop, and never stage a DB file, a
`.env`, or anything under `storage/`.

## Reporting back

Each spec ends with a **Report** section naming exactly what to state on
completion. The umbrella answer WS-C owes its caller is: which of handoff steps
1–8 are done, the final schema with its reserved columns, the answer to the
utility-call session-id question (CV), and confirmation that `/ingest/conduit`
matches the frozen seam contract.

## The two rules people get wrong

**The two-feed metrics rule.** SAGA's metrics have two independent sources.
Kiro-routed traffic (Claude via Claude Code, Luna via Codex) arrives through the
CONDUIT seam on Door A. Gemini never passes through CONDUIT at all — SAGA is its
reverse proxy and parses Google's own response on Door B. Build the metrics layer
expecting both. Gemini's token counts are lossless on the wire but there is **no
credit figure** (Vertex bills GCP-side), so `credits` stays null on that feed.

**Session identity is not uniform across harnesses.** Design for the worst case
first, which is Gemini:

| Harness | Session id on wire? | Turn boundary on wire? |
|---|---|---|
| Codex | yes (`client_metadata.session_id`) | yes (`turn_id`) — best case |
| Claude Code | yes (`metadata.user_id.session_id`) | no — infer from human-turn boundary |
| Gemini (Vertex) | **no** | **no** — install-scoped id only |

SAGA must synthesize Gemini's grouping key itself. The finding that suggested
CONDUIT inject it is wrong for this architecture — Gemini never reaches CONDUIT.
