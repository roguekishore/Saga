import { TurnTree } from '../components/TurnTree';
import { HIERARCHY_FIXTURES } from '../lib/hierarchy-fixtures';

/**
 * The hierarchy view — STUB. Owned and filled by C6.
 * Spec: `docs/ws-c/C6-hierarchy-ui.md`.
 *
 * This is the payoff rung of WS-C. Everything else exists so a reader can open
 * one human-typed message and see the stream of back-and-forth it caused, with
 * exactly what was injected into each step.
 *
 * That framing is the acceptance test: a page that lists requests prettily has
 * FAILED, even if every field renders.
 *
 * ===========================================================================
 * TODO(C6):
 *  - Build against `HIERARCHY_FIXTURES` first. C5 ships the real API in parallel;
 *    do not block on it, and do not wait to see data before designing.
 *  - BOTH VIEWS STAY. The existing live WebSocket firehose is not replaced:
 *    firehose = "what is happening now", hierarchy = "understand what happened".
 *    Do not fold one into the other and do not wire the socket into the tree; use
 *    the existing query-client conventions if it needs refreshing.
 *  - Per-exchange label is `[<harness> → <model>]` plus what the model replied,
 *    with injection tags beneath.
 *  - One caveat so you do not over-claim: the request→response cadence SAGA
 *    captures over HTTP IS reliable. Do not conflate it with the gateway's
 *    alternation padding, which distorts how history is represented inside a
 *    request but does not touch the real pairing. Turn labeling stays clean even
 *    when in-request history is polluted.
 * ===========================================================================
 */
export function HierarchyPage(): React.ReactElement {
  return (
    <section>
      <h1>Hierarchy</h1>
      <p>project → conversation → human message → the requests it triggered → injection tags</p>
      <TurnTree turns={HIERARCHY_FIXTURES.turns} />
    </section>
  );
}
