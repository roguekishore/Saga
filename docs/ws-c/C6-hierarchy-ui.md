# C6 — Hierarchy UI

*Runs after C0. Parallel with C1–C5. Read `docs/ws-c/README.md`, C0's report, and
**`packages/ui/DESIGN.md`** — the design system already answers most of the
questions this page raises.*

## Why this exists

This is the payoff rung. Everything else in WS-C exists so a reader can open one
human-typed message and see the stream of back-and-forth it caused, with exactly
what was injected into each step.

That framing is the acceptance test. A page that lists requests prettily has
failed even if every field renders.

## You own (exclusive write)

```
apps/web/src/pages/HierarchyPage.tsx
apps/web/src/components/TurnTree.tsx
apps/web/src/components/InjectionTags.tsx
apps/web/src/lib/hierarchy-fixtures.ts
```

`main.tsx` and `AppShell.tsx` are **C0's** — it registered your route and nav entry
pointing at your page, because every UI workstream would otherwise contend for those
two files. `lib/api.ts`, `lib/ws.ts`, and `lib/live-store.ts` are read-only: if you
need a new fetch helper, put it in your own module rather than editing the shared
one.

## Build against fixtures first

C5 is building the API in parallel with you. Do not wait for it, and do not block on
it.

`lib/hierarchy-fixtures.ts` is yours precisely so the page is buildable and
reviewable on day one. Shape the fixtures from **C0's frozen response schemas**, not
from your own guess — they are the contract you and C5 share. Cover the states that
matter, because these are the ones a naive implementation gets wrong:

- A turn with one exchange, and a turn with thirty.
- A turn still open (`ended_at` null).
- A turn that began before SAGA was watching (C3's honest partial turn).
- Mixed provenance inside one turn.
- Null `credits` and null cache counters.
- A Door A row awaiting its seam payload, next to a Gemini row that will never have
  one.
- All three `call_role` values plus `unknown`.
- Both injection sources: `conduit-declared` and `saga-observed`.

## Both views stay

The existing live WebSocket firehose is **not** replaced. Two views, two jobs:

- **Firehose** = "what is happening now."
- **Hierarchy** = "understand what happened."

Do not fold one into the other, and do not add a live-tailing mode to the tree. If
the hierarchy needs to refresh, use the existing query-client conventions
(`staleTime` is already configured globally) rather than wiring the socket into a
tree.

## The design system already decided most of this

`packages/ui/DESIGN.md` exists and its whole premise is that the product's honesty
contract *is* the visual signature. Use it; do not invent parallel styling.

What it gives you directly:

| Need | Token | Mark |
|---|---|---|
| provider-reported | `--saga-prov-upstream` | solid disc |
| gateway-computed | `--saga-prov-gateway` | ring |
| SAGA heuristic | `--saga-prov-saga` | diamond |
| guessed structure | `--saga-inferred` | dashed ring / dashed border |

Three rules from that document that constrain this page hard:

1. **Color is never the only channel.** Every provenance tone pairs with a distinct
   mark shape; every status pairs with a label; inferred always carries dashing. A
   colorblind reader and a grayscale printout must both still work.
2. **Mixed aggregates** render a three-stop gradient disc and say "mixed" inline.
   A turn mixing provenance is the common case, not an edge case.
3. **Text vs mark tones differ.** The teal cannot darken to text contrast without
   collapsing the lightness ladder against rose, so provenance rendered as *text*
   takes the `-ink` step while marks keep the ladder hue. Gateway-lime and rose are
   mark-only and never render as body text.

Gold is the only chrome hue — links, focus rings, active state, the live pulse. It
is **not** a data color, so do not reach for it to highlight a turn.

## Honesty is the point, not a nicety

Every grouping and number on this page carries whether it is evidence or a guess,
and the reader must be able to tell without hovering:

- **`boundary_source`** — a Codex turn boundary is wire truth; a Claude Code or
  Gemini one is SAGA's inference. Dashed treatment for inferred, per the design
  system.
- **`call_role_source`** — same split. Codex declares it; the others are
  fingerprinted.
- **`sessionIdSource`** — the existing `client-declared` vs `inferred` distinction,
  already modeled elsewhere in the app.
- **`evidence: string[]`** — C3 populates this with *why* a request was classified
  as it was. Surface it. It is the difference between a label the reader must trust
  and one they can check.
- **Null is "n/a", never 0.** A missing credit figure and a zero credit figure must
  not render alike.

## Three things to render loudly

**`context_usage_percentage` climbing across a turn.** C5 serves the readings
ordered and unaggregated. This is the agentic loop made visible — N readings that
rise as the re-shipped conversation grows, where N is the number of round-trips the
instruction took. A sparkline or small ladder per turn earns its space here.

**`environment_context:diff` (Codex).** A *partial* per-turn context block. It means
"what the model knew" is spread across several requests rather than contained in
one, which changes how a reader must interpret any single request in the turn. C2
was told to surface it loudly; do not let it render as just another quiet chip.

**Timing.** It is the part of this hierarchy that is fully real on day one — SAGA
measures wall-clock itself, so the turn span and per-exchange latency are
trustworthy before any metrics plumbing fills in. Lead with what is real.

## Per-exchange label

Each exchange is one harness→model round-trip: `[<harness> → <model>]` and what the
model replied with, text or tool call, with its injection tags beneath.

One caveat worth understanding so you do not over-claim: the clean
request→response→request cadence SAGA captures over HTTP **is** reliable. Do not
conflate it with the gateway's alternation *padding*, which distorts how history is
represented *inside* a request but does not touch the real pairing. Turn labeling
stays clean even when in-request history is polluted.

## Accessibility

A collapsible tree is one of the easier things to make unusable. It needs real
semantics, not nested `div`s with click handlers: keyboard navigation, correct
expanded/collapsed state exposed to assistive technology, focus that survives
expansion, and visible focus rings (gold, per the design system). Every provenance
mark needs a text or `aria` equivalent, since the whole point of the mark-shape
system is that color is not load-bearing.

Full WCAG validation needs manual testing with assistive technology and expert
review — that is out of scope here. What is in scope is not shipping a tree that
only works with a mouse.

## Performance

Every page is its own lazy chunk and heavy vendors are split further in
`vite.config` so no route drags a renderer it does not use. A thirty-exchange turn
inside a long session is a lot of DOM — keep collapsed turns cheap, and do not pull
in a charting or graph vendor for a sparkline. There is precedent: a recharts
sparkline was already replaced with inline SVG in this codebase for exactly that
reason.

## Verification

The four gates in the README, all clean. Additionally: the page renders from
fixtures with no backend running, and every fixture state above is reachable in the
UI. State plainly whether you were able to run it against real C5 data or fixtures
only.

## Report

1. What the page renders, and which fixture states are covered.
2. How evidence vs inference is signaled — per field, and per the design system's
   mark shapes rather than color alone.
3. How the three loud things (context-usage climb, `environment_context:diff`,
   timing) are surfaced.
4. Keyboard and assistive-technology support for the tree, and what remains
   unverified.
5. Whether you rendered against real data or fixtures only.
6. Anything C0's frozen shapes made awkward to display — that is signal about the
   contract, and worth stating rather than working around.
