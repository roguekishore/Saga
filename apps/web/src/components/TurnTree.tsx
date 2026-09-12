import type { Exchange, TurnDetail } from '@saga/contracts';
import { AggValue, Badge, cn, InferredTag, NaValue, ProvenanceMark, Sparkline, Tip, WireTag } from '@saga/ui';
import { AlertTriangle, ChevronRight, Clock, Zap } from 'lucide-react';
import { InjectionTags } from './InjectionTags';

/**
 * TurnTree — the hierarchy view's spine.
 *
 * A turn is one human instruction and the loop it started. requestCount is how
 * many round-trips it actually took. That distinction — not "a request" but "the
 * thing the user typed" — is what makes this view meaningful.
 *
 * Evidence vs inference is visible without hovering:
 *   boundarySource: 'harness-declared' → solid left border  (wire truth)
 *   boundarySource: 'inferred'         → dashed left border (SAGA's guess)
 *   callRoleSource: 'harness-declared' → WireTag            (solid)
 *   callRoleSource: 'inferred'         → InferredTag        (dashed violet)
 *
 * partial: true → "capture began mid-loop" — not a short complete turn.
 * contextUsageReadings → Sparkline (DO NOT average; the climb IS the story).
 * Timing leads because spanMs is SAGA's own wall-clock, real on day one.
 */

// ---------------------------------------------------------------- formatters

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function fmtTs(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------- seam status

const SEAM_PROPS: Record<
  Exchange['seamStatus'],
  { tone: React.ComponentProps<typeof Badge>['tone']; label: string; title: string }
> = {
  present:       { tone: 'ok',      label: 'seam ✓',   title: 'CONDUIT seam payload received; metrics are from the upstream side of the gateway.' },
  pending:       { tone: 'warn',    label: 'seam …',   title: 'Door A — seam payload not yet arrived from CONDUIT. Metrics will upgrade when it lands.' },
  'not-applicable': { tone: 'neutral', label: 'no seam', title: 'Gemini feed — no seam payload will ever arrive. Vertex bills GCP-side.' },
};

function SeamBadge({ status }: { status: Exchange['seamStatus'] }) {
  const p = SEAM_PROPS[status];
  return (
    <Tip content={p.title}>
      <span>
        <Badge tone={p.tone} aria-label={`seam status: ${status}`}>{p.label}</Badge>
      </span>
    </Tip>
  );
}

// ---------------------------------------------------------------- call-role badge

const ROLE_LABEL: Record<Exchange['callRole'], string> = {
  main: 'main',
  subagent: 'sub-agent',
  utility: 'utility',
  unknown: 'unknown',
};

function CallRoleBadge({
  role,
  source,
  evidence,
}: {
  role: Exchange['callRole'];
  source: Exchange['callRoleSource'];
  evidence: string[];
}) {
  const evidenceText = evidence.length > 0 ? evidence.join(' · ') : 'No evidence recorded.';
  const label = ROLE_LABEL[role];
  return (
    <Tip content={`call role: ${label} — ${evidenceText}`}>
      <span className="inline-flex items-center gap-1">
        <Badge tone="neutral" aria-label={`call role: ${label}`}>{label}</Badge>
        {source === 'inferred' ? (
          <InferredTag what="callRole" />
        ) : (
          <WireTag what="callRole" label="declared" />
        )}
      </span>
    </Tip>
  );
}

// ---------------------------------------------------------------- single exchange row

function ExchangeRow({ ex }: { ex: Exchange }) {
  const harness = ex.harness === 'unknown' ? '?' : ex.harness;
  const model = ex.model ?? 'unknown model';

  return (
    <li className="border-t border-line first:border-t-0">
      <details className="group/ex">
        <summary
          className={cn(
            'flex cursor-pointer list-none items-start gap-2 px-3 py-2',
            'hover:bg-raised/60',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
            '[&::-webkit-details-marker]:hidden',
          )}
        >
          {/* expand chevron */}
          <ChevronRight
            className="mt-0.5 size-3.5 shrink-0 text-ink-faint transition-transform duration-(--dur-1) group-open/ex:rotate-90"
            aria-hidden
          />

          {/* seq + harness→model label */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
              <span className="font-mono text-ink-faint">#{ex.seqInTurn}</span>
              <span className="font-medium text-ink">
                [{harness} → {model}]
              </span>
              {ex.status === 'upstream_error' || ex.status === 'client_aborted' || ex.status === 'capture_incomplete' ? (
                <Badge tone="err">{ex.status.replace(/_/g, ' ')}</Badge>
              ) : ex.status === null ? (
                <Badge tone="info">in flight</Badge>
              ) : null}
              <SeamBadge status={ex.seamStatus} />
              <CallRoleBadge
                role={ex.callRole}
                source={ex.callRoleSource}
                evidence={ex.callRoleEvidence}
              />
            </div>
          </div>

          {/* latency — leads because it's real */}
          <div className="shrink-0 text-right font-mono text-[10.5px] text-ink-faint">
            {ex.latencyMs != null ? (
              <span className="flex items-center gap-0.5">
                <Clock className="size-3" aria-hidden />
                <span aria-label={`latency: ${ex.latencyMs}ms`}>{fmtDuration(ex.latencyMs)}</span>
              </span>
            ) : (
              <NaValue reason="Latency not yet recorded — request in flight or metrics pending." />
            )}
          </div>
        </summary>

        {/* expanded exchange detail */}
        <div className="space-y-2 px-4 pb-3 pt-1 pl-8">
          {/* injection tags */}
          {ex.injections.length > 0 ? (
            <section aria-label="injection tags">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                injections
              </div>
              <InjectionTags tags={ex.injections} />
            </section>
          ) : (
            <p className="text-[11px] text-ink-faint">No injections observed on this exchange.</p>
          )}

          {/* token usage */}
          <section
            aria-label="token usage"
            className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]"
          >
            <span className="text-ink-faint">
              in:{' '}
              {ex.usage.input ? (
                <span className="inline-flex items-center gap-1 font-mono">
                  <ProvenanceMark tone={
                    ex.usage.input.source === 'upstream-reported' ? 'upstream' :
                    ex.usage.input.source === 'gateway-computed' ? 'gateway' : 'saga'
                  } />
                  <span aria-label={`input tokens: ${ex.usage.input.value}`}>
                    {ex.usage.input.value.toLocaleString()}
                  </span>
                </span>
              ) : (
                <NaValue reason="Input token count not available for this exchange." />
              )}
            </span>
            <span className="text-ink-faint">
              out:{' '}
              {ex.usage.output ? (
                <span className="inline-flex items-center gap-1 font-mono">
                  <ProvenanceMark tone={
                    ex.usage.output.source === 'upstream-reported' ? 'upstream' :
                    ex.usage.output.source === 'gateway-computed' ? 'gateway' : 'saga'
                  } />
                  <span aria-label={`output tokens: ${ex.usage.output.value}`}>
                    {ex.usage.output.value.toLocaleString()}
                  </span>
                </span>
              ) : (
                <NaValue reason="Output token count not available for this exchange." />
              )}
            </span>
            <span className="text-ink-faint">
              cache read:{' '}
              {ex.usage.cacheRead ? (
                <span className="font-mono">{ex.usage.cacheRead.value.toLocaleString()}</span>
              ) : (
                <NaValue reason="Cache read not available — upstream does not report cache counters, or no cache hit." />
              )}
            </span>
            <span className="text-ink-faint">
              credits:{' '}
              {ex.credits != null ? (
                <span className="font-mono">{ex.credits.toFixed(4)}</span>
              ) : (
                <NaValue reason="Credits null — Gemini bills GCP-side (never has credits), or metrics not yet arrived." />
              )}
            </span>
            {ex.contextUsagePercentage != null ? (
              <span className="text-ink-faint">
                ctx:{' '}
                <span className="font-mono text-ink-dim">
                  {ex.contextUsagePercentage.toFixed(1)}%
                </span>
              </span>
            ) : null}
          </section>

          {/* reply preview */}
          {ex.replyPreview ? (
            <p className="rounded bg-raised/60 px-2 py-1.5 text-[11.5px] text-ink-dim italic">
              {ex.replyPreview}
            </p>
          ) : null}

          {/* tool calls */}
          {ex.toolCalls.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {ex.toolCalls.map((tc) => (
                <Badge key={tc.toolUseId} tone="info" aria-label={`tool call: ${tc.name}`}>
                  <Zap className="size-2.5" aria-hidden /> {tc.name}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

// ---------------------------------------------------------------- single turn row

function TurnRow({ detail }: { detail: TurnDetail }) {
  const { turn, exchanges } = detail;

  // boundarySource drives the left border: dashed = inferred, solid = harness-declared
  const borderClass =
    turn.boundarySource === 'harness-declared'
      ? 'border-l-2 border-l-prov-upstream/60'   // solid — wire truth
      : 'border-l-2 border-l-inferred/60 [border-left-style:dashed]'; // dashed — SAGA guess

  // Sparkline: contextUsageReadings are ordered percentages that climb across the turn
  const sparkData = turn.contextUsageReadings.map((v, i) => ({ t: i, v }));

  const hasContextClimb = sparkData.length >= 2;

  return (
    <li className="rounded-[10px] border border-line bg-surface shadow-card">
      <details className="group/turn" aria-label={`Turn ${turn.seq}`}>
        <summary
          className={cn(
            'flex cursor-pointer list-none items-start gap-3 rounded-[10px] px-4 py-3',
            'hover:bg-raised/40',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
            '[&::-webkit-details-marker]:hidden',
            borderClass,
          )}
          aria-expanded="false"
        >
          {/* expand chevron */}
          <ChevronRight
            className="mt-0.5 size-4 shrink-0 text-ink-faint transition-transform duration-(--dur-1) group-open/turn:rotate-90"
            aria-hidden
          />

          {/* main turn info */}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {/* seq */}
              <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">
                Turn {turn.seq}
              </span>

              {/* partial badge — must not look like a short complete turn */}
              {turn.partial ? (
                <Badge tone="warn" aria-label="capture began mid-loop — this turn is genuinely incomplete">
                  <AlertTriangle className="size-3" aria-hidden />
                  capture began mid-loop
                </Badge>
              ) : null}

              {/* open turn */}
              {turn.endedAt === null ? (
                <Badge tone="info" aria-label="turn still open">in progress</Badge>
              ) : null}

              {turn.errors > 0 ? (
                <Badge tone="err" aria-label={`${turn.errors} error${turn.errors === 1 ? '' : 's'} in this turn`}>
                  {turn.errors} err
                </Badge>
              ) : null}

              {/* boundary source — the most important epistemic signal */}
              {turn.boundarySource === 'harness-declared' ? (
                <WireTag what="boundary" label="boundary declared" />
              ) : (
                <InferredTag what="boundary" />
              )}
            </div>

            {/* timing + request count — timing leads because it's SAGA's own measurement */}
            <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-ink-dim">
              <span className="flex items-center gap-1">
                <Clock className="size-3 shrink-0 text-ink-faint" aria-hidden />
                {turn.spanMs != null ? (
                  <span aria-label={`turn duration: ${fmtDuration(turn.spanMs)}`}>
                    {fmtDuration(turn.spanMs)}
                  </span>
                ) : (
                  <NaValue reason="Turn not yet closed; duration unknown." />
                )}
              </span>
              <span aria-label={`${turn.requestCount} round-trips`}>
                {turn.requestCount} round-trip{turn.requestCount === 1 ? '' : 's'}
              </span>
              <span className="font-mono text-[10.5px] text-ink-faint" aria-label={`started at ${fmtTs(turn.startedAt)}`}>
                {fmtTs(turn.startedAt)}
              </span>
            </div>

            {/* token aggregates */}
            <div className="flex flex-wrap gap-3 text-[11px]">
              <span className="flex items-center gap-1 text-ink-faint">
                in: <AggValue agg={turn.inputTokens} naReason="No input tokens recorded for this turn." />
              </span>
              <span className="flex items-center gap-1 text-ink-faint">
                out: <AggValue agg={turn.outputTokens} naReason="No output tokens recorded for this turn." />
              </span>
              {turn.thoughtTokens.value > 0 ? (
                <span className="flex items-center gap-1 text-ink-faint">
                  thought: <AggValue agg={turn.thoughtTokens} naReason="No reasoning tokens." />
                </span>
              ) : null}
              <span className="text-ink-faint">
                credits:{' '}
                {turn.credits != null ? (
                  <span className="font-mono">{turn.credits.toFixed(4)}</span>
                ) : (
                  <NaValue reason="Credits null — Gemini turn (no credits), or mixed feeds including Gemini." />
                )}
              </span>
            </div>
          </div>

          {/* context-usage sparkline — the agentic loop made visible */}
          {hasContextClimb ? (
            <div className="shrink-0" aria-label={`context usage: ${turn.contextUsageReadings[0]?.toFixed(0)}% → ${turn.contextUsageReadings.at(-1)?.toFixed(0)}% across ${turn.contextUsageReadings.length} exchanges`}>
              <div className="text-[9.5px] uppercase tracking-[0.1em] text-ink-faint mb-0.5 text-right">
                ctx climb
              </div>
              <div className="h-8 w-24 overflow-hidden rounded-sm bg-raised/60">
                <Sparkline data={sparkData} />
              </div>
              <div className="mt-px text-right font-mono text-[9.5px] text-ink-faint">
                {turn.contextUsageReadings[0]?.toFixed(0)}% →{' '}
                {turn.contextUsageReadings.at(-1)?.toFixed(0)}%
              </div>
            </div>
          ) : null}
        </summary>

        {/* expanded turn body */}
        <div className="border-t border-line px-4 pt-3 pb-4 space-y-4">
          {/* evidence — WHY was this boundary drawn here? */}
          {turn.evidence.length > 0 ? (
            <section aria-label="boundary evidence">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                boundary evidence
                {turn.boundarySource === 'inferred' ? (
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    — SAGA derived this boundary heuristically
                  </span>
                ) : (
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    — stated on the wire
                  </span>
                )}
              </div>
              <ul className="space-y-0.5">
                {turn.evidence.map((e, i) => (
                  <li
                    key={i}
                    className={cn(
                      'flex items-start gap-2 text-[11.5px] text-ink-dim',
                      turn.boundarySource === 'inferred'
                        ? 'before:mt-1.5 before:block before:size-1 before:shrink-0 before:rounded-sm before:bg-inferred/60'
                        : 'before:mt-1.5 before:block before:size-1 before:shrink-0 before:rounded-full before:bg-prov-upstream/60',
                    )}
                  >
                    {e}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* exchanges */}
          {exchanges.length > 0 ? (
            <section aria-label={`${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}`}>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                exchanges ({exchanges.length})
              </div>
              <ul
                role="list"
                className="rounded-md border border-line divide-y divide-line overflow-hidden bg-canvas/60"
              >
                {exchanges.map((ex) => (
                  <ExchangeRow key={ex.requestId} ex={ex} />
                ))}
              </ul>
            </section>
          ) : (
            <p className="text-[11.5px] text-ink-faint">No exchanges recorded in this turn.</p>
          )}
        </div>
      </details>
    </li>
  );
}

// ---------------------------------------------------------------- public component

export function TurnTree({ details }: { details: TurnDetail[] }): React.ReactElement {
  if (details.length === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-ink-faint">No turns recorded yet.</p>
    );
  }

  return (
    <ol
      aria-label={`${details.length} turn${details.length === 1 ? '' : 's'}`}
      className="space-y-3"
    >
      {details.map((d) => (
        <TurnRow key={d.turn.turnId} detail={d} />
      ))}
    </ol>
  );
}
