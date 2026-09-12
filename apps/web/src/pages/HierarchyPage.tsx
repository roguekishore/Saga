import { ProvenanceLegend } from '@saga/ui';
import { TurnTree } from '../components/TurnTree';
import { HIERARCHY_FIXTURES } from '../lib/hierarchy-fixtures';

/**
 * HierarchyPage — the payoff rung of WS-C.
 *
 * Framing: project → conversation → human message → the requests it triggered
 * → injection tags.
 *
 * This view answers "understand what happened". The live WebSocket firehose on
 * /live answers "what is happening now". They are separate views with separate
 * jobs; the socket is NOT wired into this tree.
 *
 * Rendered against fixtures while C5 (the read API) builds in parallel.
 */
export function HierarchyPage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
      {/* -------------------------------------------------------- heading */}
      <div className="space-y-1">
        <h1 className="text-[22px] font-bold tracking-tight text-ink">Hierarchy</h1>
        <p className="max-w-2xl text-[13px] leading-5 text-ink-dim">
          For each human message, the stream of back-and-forth it caused — and exactly what was
          injected into each step. A turn is the unit a human recognises as{' '}
          <em>"the thing I asked for"</em>;{' '}
          <code className="font-mono text-[12px]">requestCount</code> is how many round-trips it
          actually took.
        </p>
        <p className="text-[11.5px] text-ink-faint">
          Rendered from fixtures — backend not required.
        </p>
      </div>

      {/* ------------------------------------------------ provenance legend */}
      <div className="rounded-md border border-line bg-surface px-3.5 py-2.5">
        <ProvenanceLegend />
        <p className="mt-1.5 text-[10.5px] text-ink-faint">
          <strong className="font-semibold text-ink-dim">Dashed</strong> = SAGA inferred (turn
          boundary, call role, session edge). Solid = stated on the wire. The distinction is always
          visible without hovering.
        </p>
      </div>

      {/* --------------------------------------------------- fixture notice */}
      <div className="rounded-md border border-line-strong/60 bg-canvas px-3 py-2 text-[11.5px] text-ink-dim">
        <span className="mr-1 font-semibold">Fixture states covered:</span>1 exchange · 30-exchange
        loop · open turn (endedAt null) · partial turn (capture began mid-loop) · mixed provenance ·
        pending seam · not-applicable seam · all callRole values · both injection sources ·
        environment_context:diff callout · null credits (n/a, not 0)
      </div>

      {/* ------------------------------------------------------ turn tree */}
      <TurnTree details={HIERARCHY_FIXTURES.details} />
    </div>
  );
}
