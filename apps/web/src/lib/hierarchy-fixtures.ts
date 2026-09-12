import type { Exchange, TurnDetail, TurnSummary } from '@saga/contracts';

/**
 * Fixtures for the hierarchy view — STUB. Owned and filled by C6.
 * Spec: `docs/ws-c/C6-hierarchy-ui.md`.
 *
 * C5 (the read API) is being built in parallel with C6, so the page must be
 * buildable and reviewable without a backend. Shape these from the FROZEN
 * schemas in `@saga/contracts`, not from a guess — those schemas are the contract
 * C5 and C6 share.
 *
 * ===========================================================================
 * TODO(C6): cover the states a naive implementation gets wrong. These are not a
 * wishlist; each is a case where the honest rendering differs from the obvious
 * one:
 *
 *  - a turn with one exchange, and a turn with thirty
 *  - a turn still open (`endedAt` null)
 *  - a turn that began before SAGA was watching (`partial: true`)
 *  - MIXED provenance inside one turn (`AggUsage.sources` with 2+ entries)
 *  - null `credits` and null cache counters — must render "n/a", never 0
 *  - a door-A row with `seamStatus: 'pending'` NEXT TO a door-B row with
 *    `'not-applicable'`, because those must not look alike
 *  - all three `callRole` values plus `unknown`
 *  - both injection sources: `conduit-declared` and `saga-observed`
 *  - `boundarySource: 'harness-declared'` (Codex) vs `'inferred'` (the others),
 *    since the design system dashes the inferred ones
 * ===========================================================================
 */

export const HIERARCHY_FIXTURES: { turns: TurnSummary[]; details: TurnDetail[] } = {
  turns: [],
  details: [],
};

export const EMPTY_EXCHANGES: Exchange[] = [];
