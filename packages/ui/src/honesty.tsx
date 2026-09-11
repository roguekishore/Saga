import type { AggUsage, BlockContext, Provenance, UsageValue } from '@saga/contracts';
import { HelpCircle } from 'lucide-react';
import { useId } from 'react';
import { cn } from './cn';
import { fmtTokens } from './format';
import { Tip } from './primitives';
import {
  BLOCK_CONTEXT_META,
  describeSources,
  INFERRED_EXPLAIN,
  PROVENANCE_META,
  WIRE_EXPLAIN,
} from './provenance-meta';

/**
 * The honesty components. A number without provenance, or a heuristic
 * presented as truth, is a bug — these are the only way numbers render.
 *
 * Provenance is double-encoded, color + shape, so it survives color-vision
 * deficiency and grayscale print:
 *   upstream-reported → teal solid disc     (the provider said so)
 *   gateway-computed  → lime hollow ring    (a middleman computed it)
 *   saga-estimated    → rose diamond        (SAGA's own heuristic)
 *   mixed             → gradient disc       (aggregate of several sources)
 *   inferred          → violet dashed ring  (structure SAGA guessed)
 */

export type ProvenanceTone = 'upstream' | 'gateway' | 'saga' | 'mixed' | 'none' | 'inferred';

export function ProvenanceMark({ tone, className }: { tone: ProvenanceTone; className?: string }) {
  const gid = useId();
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden
      className={cn('inline-block size-[9px] shrink-0', className)}
    >
      {tone === 'upstream' ? <circle cx="5" cy="5" r="3.4" className="fill-prov-upstream" /> : null}
      {tone === 'gateway' ? (
        <circle cx="5" cy="5" r="3" fill="none" strokeWidth="1.8" className="stroke-prov-gateway" />
      ) : null}
      {tone === 'saga' ? (
        <path d="M5 1.1 L8.9 5 L5 8.9 L1.1 5 Z" className="fill-prov-saga" />
      ) : null}
      {tone === 'mixed' ? (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--saga-prov-upstream)" />
              <stop offset="50%" stopColor="var(--saga-prov-gateway)" />
              <stop offset="100%" stopColor="var(--saga-prov-saga)" />
            </linearGradient>
          </defs>
          <circle cx="5" cy="5" r="3.4" fill={`url(#${gid})`} />
        </>
      ) : null}
      {tone === 'inferred' ? (
        <circle
          cx="5"
          cy="5"
          r="3"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray="2 1.7"
          className="stroke-inferred"
        />
      ) : null}
      {tone === 'none' ? <circle cx="5" cy="5" r="2.2" className="fill-line-strong" /> : null}
    </svg>
  );
}

/** Transitional alias — prefer ProvenanceMark. */
export const ProvenanceDot = ProvenanceMark;

/** Rich hover content for a provenance mark: what the claim is, verbatim. */
function ProvCard({ title, explain }: { title: string; explain: string }) {
  return (
    <span className="block max-w-[300px]">
      <b className="font-semibold">{title}</b>
      <span className="mt-0.5 block text-ink-dim">{explain}</span>
    </span>
  );
}

/** A token count with its source — the atom of the whole UI. */
export function TokenValue({
  usage,
  naReason,
  className,
}: {
  usage: UsageValue | null;
  naReason?: string;
  className?: string;
}) {
  if (usage == null) return <NaValue reason={naReason} className={className} />;
  const meta = PROVENANCE_META[usage.source];
  return (
    <Tip content={<ProvCard title={meta.label} explain={meta.explain} />}>
      <span
        className={cn(
          'inline-flex cursor-default items-center gap-1.5 font-mono tabular-nums',
          className,
        )}
      >
        <ProvenanceMark tone={meta.tone} />
        {fmtTokens(usage.value)}
      </span>
    </Tip>
  );
}

/** An aggregate with its full source list (possibly mixed). */
export function AggValue({
  agg,
  render = fmtTokens,
  naReason,
  className,
}: {
  agg: AggUsage;
  render?: (n: number) => string;
  naReason?: string;
  className?: string;
}) {
  const d = describeSources(agg.sources);
  if (d.tone === 'none') return <NaValue reason={naReason ?? d.explain} className={className} />;
  return (
    <Tip content={<ProvCard title={d.short} explain={d.explain} />}>
      <span
        className={cn(
          'inline-flex cursor-default items-center gap-1.5 font-mono tabular-nums',
          className,
        )}
      >
        <ProvenanceMark tone={d.tone} />
        {render(agg.value)}
        {d.tone === 'mixed' ? (
          <span className="text-[10px] font-sans font-normal uppercase tracking-wide text-ink-faint">
            mixed
          </span>
        ) : null}
      </span>
    </Tip>
  );
}

/** Honest absence: n/a with the reason one hover away. Never renders 0. */
export function NaValue({ reason, className }: { reason?: string; className?: string }) {
  const content = reason ?? 'No source exists for this number on the current upstream.';
  return (
    <Tip content={content}>
      <span
        className={cn('inline-flex cursor-default items-center gap-1 text-ink-faint', className)}
      >
        n/a
        <HelpCircle className="size-3 opacity-60" />
      </span>
    </Tip>
  );
}

/** Dashed violet = "SAGA guessed this structure". */
export function InferredTag({
  what,
  className,
}: {
  what: keyof typeof INFERRED_EXPLAIN | (string & {});
  className?: string;
}) {
  const explain = INFERRED_EXPLAIN[what] ?? 'Derived by a SAGA heuristic, not present on the wire.';
  return (
    <Tip content={explain}>
      <span
        className={cn(
          'inline-flex cursor-default items-center rounded border border-dashed border-inferred/60',
          'px-1 py-px text-[10px] font-medium leading-3.5 text-inferred',
          className,
        )}
      >
        inferred
      </span>
    </Tip>
  );
}

/**
 * The counterpart to `InferredTag`: a fact the client stated on the wire, or
 * read verbatim from its own files. Solid border against the inferred tag's
 * dashed one, so "evidence" and "guess" are distinguishable at a glance
 * without reading either label.
 *
 * Use it only where the claim really is wire-stated. A tag that says "stated"
 * over a heuristic is worse than no tag at all.
 */
export function WireTag({
  what,
  label = 'stated',
  className,
}: {
  what: keyof typeof WIRE_EXPLAIN | (string & {});
  label?: string;
  className?: string;
}) {
  const explain = WIRE_EXPLAIN[what] ?? 'Stated by the client on the wire, not inferred by SAGA.';
  return (
    <Tip content={explain}>
      <span
        className={cn(
          'inline-flex cursor-default items-center rounded border border-solid',
          'border-prov-upstream/60 px-1 py-px text-[10px] font-medium leading-3.5',
          'text-prov-upstream-ink',
          className,
        )}
      >
        {label}
      </span>
    </Tip>
  );
}

/**
 * Provenance legend — the trust spectrum, coolest claim to hottest guess.
 * Every mark shape appears exactly as it renders next to real numbers.
 */
export function ProvenanceLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink-faint',
        className,
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-faint/80">
        provenance
      </span>
      {(Object.keys(PROVENANCE_META) as Provenance[]).map((p) => {
        const m = PROVENANCE_META[p];
        return (
          <Tip key={p} content={m.explain}>
            <span className="inline-flex cursor-default items-center gap-1.5">
              <ProvenanceMark tone={m.tone} /> {m.label}
            </span>
          </Tip>
        );
      })}
      <Tip content="Structure SAGA derived heuristically (sessions, workspace, agents, memory attribution).">
        <span className="inline-flex cursor-default items-center gap-1.5">
          <ProvenanceMark tone="inferred" />
          inferred structure
        </span>
      </Tip>
    </div>
  );
}

const BLOCK_TONE: Record<'you' | 'injected' | 'structural', string> = {
  // Your words get the one solid, high-contrast treatment on the card.
  you: 'border-accent/70 bg-accent/10 text-accent',
  injected: 'border-line-strong/60 bg-raised text-ink-dim',
  structural: 'border-line/60 bg-transparent text-ink-faint',
};

/**
 * Per-block label: which part of a turn the human typed, and which parts the
 * client injected around it. The dashed border is the established "SAGA
 * guessed this" signal and applies here for the same reason it does elsewhere
 * — most of these labels come from marker sniffing, including `your input`,
 * which is decided by the ABSENCE of a marker.
 */
export function BlockContextTag({ ctx, className }: { ctx: BlockContext; className?: string }) {
  const meta = BLOCK_CONTEXT_META[ctx.kind];
  return (
    <Tip
      content={
        <span>
          <b className="font-semibold">{meta.label}</b> — {meta.explain}
          {ctx.marker ? (
            <>
              <br />
              <span className="text-ink-faint">matched marker: </span>
              <span className="font-mono">{ctx.marker}</span>
            </>
          ) : null}
        </span>
      }
    >
      <span
        className={cn(
          'inline-flex cursor-default items-center gap-1 rounded border px-1.5 py-px',
          'text-[10px] font-medium uppercase leading-4 tracking-[0.06em]',
          ctx.inferred ? 'border-dashed' : 'border-solid',
          BLOCK_TONE[meta.tone],
          className,
        )}
      >
        {meta.label}
        {ctx.inferred ? <span className="opacity-70">?</span> : null}
      </span>
    </Tip>
  );
}
