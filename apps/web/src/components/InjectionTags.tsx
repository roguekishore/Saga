import type { InjectionTag } from '@saga/contracts';
import { Badge, cn, Tip } from '@saga/ui';
import { Eye, Radio } from 'lucide-react';

/**
 * InjectionTags — what was pushed into each exchange.
 *
 * Two sources, two epistemic statuses:
 *   saga-observed  — SAGA saw it on the front door before any gateway.
 *                    Solid border. SAGA is the direct witness.
 *   conduit-declared — CONDUIT reported adding it; SAGA sits on the wrong side
 *                    of the rewrite and cannot verify. Dashed border, same visual
 *                    language as "inferred" throughout the design system.
 *
 * environment_context:diff is NOT just another chip. It means "what the model
 * knew is spread across several requests" — a reader interpreting any single
 * request in the turn will be wrong without knowing this. Rendered as a callout,
 * not a tag.
 *
 * Color is never the only channel: source is always text-labeled + icon,
 * environment_context:diff carries bold text explanation.
 */

function SourcePip({ source }: { source: InjectionTag['source'] }) {
  if (source === 'saga-observed') {
    return (
      <Tip content="SAGA observed this injection on the wire before it reached the upstream. Direct evidence.">
        <span
          aria-label="saga-observed"
          className={cn(
            'inline-flex items-center gap-0.5',
            'rounded border border-solid border-prov-upstream/50',
            'px-1 py-px text-[9.5px] font-medium leading-3.5 text-prov-upstream-ink',
          )}
        >
          {/* Solid disc = upstream/wire evidence mark */}
          <svg
            viewBox="0 0 8 8"
            aria-hidden
            className="inline-block size-[7px] shrink-0 fill-prov-upstream"
          >
            <circle cx="4" cy="4" r="3" />
          </svg>
          saga
        </span>
      </Tip>
    );
  }
  return (
    <Tip content="CONDUIT declared this injection. SAGA sits on the wrong side of the gateway rewrite and cannot verify it directly — this is what CONDUIT reported adding.">
      <span
        aria-label="conduit-declared"
        className={cn(
          'inline-flex items-center gap-0.5',
          'rounded border border-dashed border-inferred/60',
          'px-1 py-px text-[9.5px] font-medium leading-3.5 text-inferred',
        )}
      >
        {/* Dashed ring = "SAGA is relying on CONDUIT's report, not direct observation" */}
        <svg viewBox="0 0 8 8" aria-hidden className="inline-block size-[7px] shrink-0">
          <circle
            cx="4"
            cy="4"
            r="2.5"
            fill="none"
            strokeWidth="1.4"
            strokeDasharray="2 1.5"
            className="stroke-inferred"
          />
        </svg>
        conduit
      </span>
    </Tip>
  );
}

/** The environment_context:diff callout — rendered loudly, not as a chip. */
function EnvContextDiffCallout({ tag }: { tag: InjectionTag }) {
  return (
    <div
      role="note"
      aria-label="environment_context:diff — spread context"
      className={cn(
        'flex items-start gap-2 rounded-md',
        'border border-warn/40 bg-warn/8 px-2.5 py-2',
        'text-[11.5px] leading-5',
      )}
    >
      <Radio className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0">
        <span className="font-semibold text-warn">environment_context:diff</span>
        <span className="ml-1.5 text-ink-dim">
          What the model knew is spread across several requests — a single exchange does not contain
          the full context.
        </span>
        {tag.location ? (
          <span className="ml-1.5 font-mono text-[10.5px] text-ink-faint">@ {tag.location}</span>
        ) : null}
        {tag.detail ? (
          <p className="mt-1 text-[10.5px] text-ink-faint">{tag.detail}</p>
        ) : null}
        <div className="mt-1">
          <SourcePip source={tag.source} />
        </div>
      </div>
    </div>
  );
}

function InjectionChip({ tag }: { tag: InjectionTag }) {
  return (
    <Tip
      content={
        tag.detail ?? (
          <span>
            Type: <code className="font-mono">{tag.type}</code>
            {tag.location ? (
              <>
                {' '}
                at <code className="font-mono">{tag.location}</code>
              </>
            ) : null}
          </span>
        )
      }
    >
      <li
        className={cn(
          'inline-flex max-w-full cursor-default items-center gap-1.5 rounded',
          'border px-1.5 py-px text-[10.5px] leading-4',
          tag.source === 'saga-observed'
            ? 'border-solid border-line-strong bg-raised text-ink-dim'
            : 'border-dashed border-inferred/40 bg-transparent text-ink-faint',
        )}
      >
        {tag.source === 'saga-observed' ? (
          <Eye className="size-3 shrink-0 text-ink-faint" aria-hidden />
        ) : (
          <Radio className="size-3 shrink-0 text-inferred" aria-hidden />
        )}
        <span className="truncate font-mono">{tag.type}</span>
        {tag.location ? (
          <span className="shrink-0 text-ink-faint">@ {tag.location}</span>
        ) : null}
        <SourcePip source={tag.source} />
      </li>
    </Tip>
  );
}

export function InjectionTags({ tags }: { tags: InjectionTag[] }): React.ReactElement | null {
  if (tags.length === 0) return null;

  // Separate out environment_context:diff tags — they render as callouts, not chips.
  const diffTags = tags.filter((t) => t.type === 'environment_context:diff');
  const chipTags = tags.filter((t) => t.type !== 'environment_context:diff');

  return (
    <div className="space-y-1.5">
      {diffTags.map((t) => (
        <EnvContextDiffCallout key={t.seq} tag={t} />
      ))}
      {chipTags.length > 0 ? (
        <ul
          aria-label={`${chipTags.length} injection tag${chipTags.length === 1 ? '' : 's'}`}
          className="flex flex-wrap gap-1"
        >
          {chipTags.map((t) => (
            // Keyed on `seq` — the store's own identity for the tag.
            <InjectionChip key={t.seq} tag={t} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
