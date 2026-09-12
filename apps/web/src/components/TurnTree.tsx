import type { TurnSummary } from '@saga/contracts';

/**
 * The nested turn tree — STUB. Owned and filled by C6.
 * Spec: `docs/ws-c/C6-hierarchy-ui.md`. Design system: `packages/ui/DESIGN.md`.
 *
 * ===========================================================================
 * TODO(C6). What this must show, and why each is load-bearing:
 *
 *  - ONE HUMAN MESSAGE, THEN ITS LOOP. A turn is not a request. It is the unit a
 *    human recognizes as "the thing I asked for", and `requestCount` is how many
 *    round-trips it actually took.
 *
 *  - EVIDENCE vs GUESS, VISIBLE WITHOUT HOVERING. `boundarySource:
 *    'harness-declared'` is wire truth (Codex states `turn_id`); `'inferred'` is
 *    SAGA deriving the boundary from payload structure. The design system dashes
 *    the inferred ones (`--saga-inferred`, dashed ring/border). Same for
 *    `callRoleSource`. And `evidence[]` records WHY — surface it, because it is
 *    the difference between a label the reader must trust and one they can check.
 *
 *  - `partial: true` means capture began mid-loop, so the turn is genuinely
 *    incomplete. Say so; do not render it as a complete turn that happens to be
 *    short.
 *
 *  - THE CONTEXT-USAGE CLIMB. `contextUsageReadings` arrives ordered and
 *    unaggregated: N readings that rise across the turn as the re-shipped
 *    conversation grows. That climb IS the agentic loop made visible and deserves
 *    a sparkline or small ladder. Do not average it, and do not pull in a charting
 *    vendor for it — a recharts sparkline was already replaced with inline SVG in
 *    this codebase for exactly that reason.
 *
 *  - TIMING LEADS. Wall-clock is SAGA's own measurement, so `spanMs` and
 *    per-exchange latency are trustworthy on day one, before any metrics plumbing
 *    fills in. Lead with what is real.
 *
 *  - ACCESSIBILITY. A collapsible tree is easy to make unusable. It needs real
 *    semantics rather than nested divs with click handlers: keyboard navigation,
 *    expanded/collapsed state exposed to assistive tech, focus that survives
 *    expansion, visible gold focus rings. Every provenance mark needs a text or
 *    aria equivalent — the whole point of the mark-shape system is that color is
 *    not load-bearing. Full WCAG validation needs manual testing with assistive
 *    technology and expert review, which is out of scope; shipping a
 *    mouse-only tree is not.
 *
 *  - PERFORMANCE. A thirty-exchange turn inside a long session is a lot of DOM.
 *    Keep collapsed turns cheap.
 * ===========================================================================
 */
export function TurnTree({ turns }: { turns: TurnSummary[] }): React.ReactElement {
  if (turns.length === 0) {
    return <p>No turns recorded yet.</p>;
  }
  return (
    <ul>
      {turns.map((t) => (
        <li key={t.turnId}>
          turn {t.seq} — {t.requestCount} request(s), boundary {t.boundarySource}
          {t.partial ? ' (partial)' : ''}
        </li>
      ))}
    </ul>
  );
}
