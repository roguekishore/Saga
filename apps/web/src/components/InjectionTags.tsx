import type { InjectionTag } from '@saga/contracts';

/**
 * Injection tags — STUB. Owned and filled by C6.
 * Spec: `docs/ws-c/C6-hierarchy-ui.md`. Design system: `packages/ui/DESIGN.md`.
 *
 * These tags ARE the product's original purpose made visible: for each thing the
 * user typed, what got injected into each step.
 *
 * ===========================================================================
 * TODO(C6). Three rules from the design system constrain this hard:
 *
 *  1. COLOR IS NEVER THE ONLY CHANNEL. Every provenance tone owns a mark shape
 *     (`--saga-prov-upstream` solid disc, `--saga-prov-gateway` ring,
 *     `--saga-prov-saga` diamond, `--saga-inferred` dashed ring). A colorblind
 *     reader and a grayscale printout must both still work, so each tag needs a
 *     text or aria equivalent.
 *  2. TEXT AND MARK TONES DIFFER. Teal cannot darken to text contrast without
 *     collapsing the CVD lightness ladder against rose, so provenance rendered as
 *     TEXT takes the `-ink` step while marks keep the ladder hue. Gateway-lime and
 *     rose are mark-only and never render as body text.
 *  3. GOLD IS CHROME, NOT DATA. Do not reach for it to highlight a tag.
 *
 * Two distinctions the reader must be able to make at a glance:
 *
 *  - `saga-observed` vs `conduit-declared`. The first SAGA saw itself on the front
 *    door; the second is CONDUIT reporting what it added, because SAGA sits on the
 *    wrong side of that rewrite and cannot verify it. That is a real difference in
 *    epistemic status, not a label.
 *  - `environment_context:diff` is NOT just another chip. It means "what the model
 *    knew" is spread across several requests rather than contained in one, which
 *    changes how any single request in the turn can be read. Surface it loudly.
 * ===========================================================================
 */
export function InjectionTags({ tags }: { tags: InjectionTag[] }): React.ReactElement | null {
  if (tags.length === 0) return null;
  return (
    <ul>
      {tags.map((t) => (
        // Keyed on `seq`, the store's own identity for the tag — not the array
        // index, which is a render artifact and breaks under reorder or filter.
        <li key={t.seq}>
          {t.type}
          {t.location ? ` @ ${t.location}` : ''} ({t.source})
        </li>
      ))}
    </ul>
  );
}
