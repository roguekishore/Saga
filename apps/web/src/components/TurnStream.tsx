import {
  type BlockContext,
  classifyBlocks,
  type ContentBlock,
  type Exchange,
  type NormalizedMessage,
  type TurnSummary,
} from '@saga/contracts';
import {
  AggValue,
  Badge,
  BLOCK_CONTEXT_META,
  BlockContextTag,
  Card,
  cn,
  EmptyState,
  fmtMs,
  fmtTokens,
  InferredTag,
  Skeleton,
  StatusPill,
  Tip,
  WireTag,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { Brain, ChevronRight, MessageSquare, Terminal, Wrench } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { BlockView } from './BlockView';

/**
 * TurnStream — the session view's spine.
 *
 * The parent is the session; each child block is ONE thing the human typed. The
 * card shows that text and nothing else, so the list reads like the
 * conversation the user remembers having. Expanding it reveals the whole
 * back-and-forth that instruction caused, with the instruction pinned above it.
 *
 * Assembled from three endpoints that already existed:
 *   /api/sessions/:id/turns  — the turn list, with per-turn token aggregates
 *   /api/turns/:id           — that turn's exchanges, in order
 *   /api/requests/:id        — each exchange's messages and reply blocks
 *
 * The stream is INTERLEAVED rather than concatenated. On the Messages API a
 * tool result does not live in the response that requested it; it arrives in
 * the NEXT request's trailing user message. So exchange i contributes its
 * assistant reply, and exchange i+1 contributes the tool results that answered
 * it. Rendering each request's full history end-to-end would instead repeat the
 * entire conversation once per round-trip.
 */

// --------------------------------------------------------------- block labels

type SpeakerTone = 'you' | 'injected' | 'structural' | 'model' | 'thinking' | 'tool';

/**
 * `model-output` covers text, thinking and tool_use alike, which is exactly the
 * distinction a reader of a turn needs back. Refine it by the block's own type —
 * structural, not sniffed, so nothing added here is a guess.
 */
function speakerOf(block: ContentBlock, ctx: BlockContext): { label: string; tone: SpeakerTone } {
  if (ctx.kind === 'model-output') {
    if (block.type === 'thinking') return { label: 'thinking', tone: 'thinking' };
    if (block.type === 'tool_use') return { label: `tool call · ${block.name}`, tone: 'tool' };
    return { label: 'model', tone: 'model' };
  }
  if (ctx.kind === 'tool-result') return { label: 'tool result', tone: 'tool' };
  return { label: BLOCK_CONTEXT_META[ctx.kind].label, tone: BLOCK_CONTEXT_META[ctx.kind].tone };
}

const TONE_RAIL: Record<SpeakerTone, string> = {
  you: 'border-accent/70',
  model: 'border-ok/60',
  thinking: 'border-thinking/50',
  tool: 'border-inferred/50',
  injected: 'border-line-strong/60',
  structural: 'border-line',
};

const TONE_TEXT: Record<SpeakerTone, string> = {
  you: 'text-accent',
  model: 'text-ok',
  thinking: 'text-thinking',
  tool: 'text-inferred',
  injected: 'text-ink-faint',
  structural: 'text-ink-faint',
};

function ToneIcon({ tone }: { tone: SpeakerTone }) {
  if (tone === 'thinking') return <Brain className="size-3" />;
  if (tone === 'tool') return <Wrench className="size-3" />;
  if (tone === 'injected' || tone === 'structural') return <Terminal className="size-3" />;
  return <MessageSquare className="size-3" />;
}

/** One block, rail-coded by who produced it, with the honest label kept. */
function StreamBlock({ block, ctx }: { block: ContentBlock; ctx: BlockContext }) {
  const [open, setOpen] = useState(false);
  const { label, tone } = speakerOf(block, ctx);
  const chars =
    block.type === 'text'
      ? block.text.length
      : block.type === 'thinking'
        ? block.thinking.length
        : 0;
  // Injected noise collapses. The human's words and the model's reply never do.
  const collapsible = tone === 'injected' && chars > 1500;

  return (
    <div className={cn('border-l-2 pl-2.5', TONE_RAIL[tone])}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.09em]',
            TONE_TEXT[tone],
          )}
        >
          <ToneIcon tone={tone} />
          {label}
        </span>
        {/* Keeps SAGA's own claim visible: whether the label was read off the
            wire or sniffed from a marker. */}
        <BlockContextTag ctx={ctx} />
        {chars > 0 ? (
          <span className="text-[10px] tabular-nums text-ink-faint">
            {chars.toLocaleString()} chars
          </span>
        ) : null}
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto cursor-pointer text-[10.5px] text-ink-faint transition-colors duration-(--dur-1) hover:text-ink"
          >
            {open ? 'collapse' : 'expand'}
          </button>
        ) : null}
      </div>
      {collapsible && !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full cursor-pointer truncate rounded-md bg-canvas/40 px-3 py-2 text-left font-mono text-[11.5px] text-ink-faint transition-colors duration-(--dur-1) hover:bg-canvas/60"
        >
          {block.type === 'text' ? block.text.slice(0, 160) : '…'}
        </button>
      ) : (
        <div className={cn(tone === 'injected' && 'opacity-80')}>
          <BlockView block={block} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- prose plucking

/**
 * What the human actually typed in this request: the trailing user message's
 * `user-prose` blocks only. Everything else in that message — the slash-command
 * echo, the captured stdout, the injected reminders — is the client talking, and
 * folding it in here is exactly the confusion this view exists to end.
 */
function humanProse(messages: NormalizedMessage[]): { text: string; harnessBlocks: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const ctxs = classifyBlocks(m.blocks, m.role);
    const mine: string[] = [];
    let harness = 0;
    m.blocks.forEach((b, j) => {
      if (ctxs[j]?.kind === 'user-prose' && b.type === 'text') mine.push(b.text);
      else harness++;
    });
    return { text: mine.join('\n\n').trim(), harnessBlocks: harness };
  }
  return { text: '', harnessBlocks: 0 };
}

/** Blocks of the trailing user message that are NOT the human's own prose. */
function trailingNonProse(
  messages: NormalizedMessage[],
): Array<{ block: ContentBlock; ctx: BlockContext }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const ctxs = classifyBlocks(m.blocks, m.role);
    const out: Array<{ block: ContentBlock; ctx: BlockContext }> = [];
    m.blocks.forEach((block, j) => {
      const ctx = ctxs[j];
      if (ctx && ctx.kind !== 'user-prose') out.push({ block, ctx });
    });
    return out;
  }
  return [];
}

// ------------------------------------------------------------------ the stream

function ExchangeStream({ exchanges }: { exchanges: Exchange[] }) {
  const ids = exchanges.map((e) => e.requestId);
  const details = useQuery({
    queryKey: ['turn-stream', ids.join(',')],
    queryFn: async () => Promise.all(ids.map((id) => api.requestDetail(id))),
  });

  if (details.isLoading) return <Skeleton className="h-40" />;
  if (details.isError || !details.data) {
    return <p className="text-[12px] text-warn">Could not load this turn&apos;s stream.</p>;
  }

  const rows: React.ReactNode[] = [];
  details.data.forEach((d, i) => {
    const ex = exchanges[i];
    if (!ex) return;

    // Round-trip header: which call this was, and what it cost.
    rows.push(
      <div
        key={`hdr-${ex.requestId}`}
        className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-ink-faint"
      >
        <span className="font-mono font-semibold text-ink-dim">round-trip {i + 1}</span>
        <StatusPill status={ex.status} />
        {ex.model ? <Badge className="font-mono">{ex.model}</Badge> : null}
        {ex.callRoleSource === 'harness-declared' ? (
          <WireTag what="call role" />
        ) : (
          <InferredTag what="call role" />
        )}
        <span className="font-mono">{ex.callRole}</span>
        <span className="font-mono tabular-nums">{fmtMs(ex.latencyMs)}</span>
        {ex.stopReason ? <span className="font-mono">stop: {ex.stopReason}</span> : null}
        <a
          href={`/requests/${ex.requestId}`}
          className="ml-auto font-mono text-accent hover:underline"
        >
          inspect →
        </a>
      </div>,
    );

    // Everything in this request's trailing user message that the human did not
    // type. Two different things land here depending on position, and both
    // belong in the stream: on the FIRST round-trip it is the harness content
    // that rode in alongside the instruction (command echo, captured stdout,
    // injected reminders); on every later one it is the tool results answering
    // the PREVIOUS round-trip. The human's own prose is pinned above instead.
    trailingNonProse(d.request.messages).forEach(({ block, ctx }, j) => {
      rows.push(<StreamBlock key={`${ex.requestId}-in-${j}`} block={block} ctx={ctx} />);
    });

    // The model's reply for this round-trip.
    const reply = d.response.message;
    if (reply) {
      const ctxs = classifyBlocks(reply.blocks, reply.role);
      reply.blocks.forEach((block, j) => {
        const ctx = ctxs[j];
        if (ctx) rows.push(<StreamBlock key={`${ex.requestId}-out-${j}`} block={block} ctx={ctx} />);
      });
    } else {
      rows.push(
        <p key={`${ex.requestId}-noreply`} className="text-[11.5px] text-ink-faint">
          No reply captured for this round-trip.
        </p>,
      );
    }
  });

  return <div className="space-y-2.5">{rows}</div>;
}

// -------------------------------------------------------------------- one turn

function TurnBlock({ turn, index }: { turn: TurnSummary; index: number }) {
  const [open, setOpen] = useState(false);

  const detail = useQuery({
    queryKey: ['turn-detail', turn.turnId],
    queryFn: () => api.turnDetail(turn.turnId),
  });
  const first = detail.data?.exchanges[0];
  const firstId = first?.requestId;

  // The human's words come from the turn's FIRST round-trip — the only one whose
  // trailing user message is the instruction rather than a tool result.
  const head = useQuery({
    queryKey: ['turn-head', firstId],
    queryFn: () => api.requestDetail(firstId as string),
    enabled: Boolean(firstId),
  });

  const prose = head.data ? humanProse(head.data.request.messages) : null;

  return (
    <Card className="overflow-hidden">
      {/* ------------------------------------------------ the message card */}
      <div className="border-b border-line/60 px-3.5 py-2.5">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px]">
          <span className="font-mono font-bold text-ink-dim">#{index + 1}</span>
          {turn.boundarySource === 'harness-declared' ? (
            <WireTag what="turn boundary" />
          ) : (
            <InferredTag what="turn boundary" />
          )}
          {turn.partial ? (
            <Tip content="Capture began mid-loop — this turn is genuinely incomplete, not short.">
              <span className="text-warn">partial</span>
            </Tip>
          ) : null}

          {/* Tokens for THIS message block. AggValue keeps provenance visible
              instead of printing a bare number. */}
          <span className="ml-auto flex flex-wrap items-center gap-3 font-mono tabular-nums">
            <Tip content="Input tokens summed over every round-trip this instruction caused.">
              <span className="text-ink-dim">
                in <AggValue agg={turn.inputTokens} render={fmtTokens} />
              </span>
            </Tip>
            <Tip content="Output tokens summed over every round-trip this instruction caused.">
              <span className="text-ink-dim">
                out <AggValue agg={turn.outputTokens} render={fmtTokens} />
              </span>
            </Tip>
            {turn.thoughtTokens.value ? (
              <Tip content="Reasoning tokens, metered separately by the upstream.">
                <span className="text-thinking">
                  think <AggValue agg={turn.thoughtTokens} render={fmtTokens} />
                </span>
              </Tip>
            ) : null}
            <span className="text-ink-faint">
              {turn.requestCount} round-trip{turn.requestCount === 1 ? '' : 's'}
            </span>
            <span className="text-ink-faint">{fmtMs(turn.spanMs)}</span>
          </span>
        </div>

        {/* The instruction itself, in full — never truncated. */}
        {head.isLoading ? (
          <Skeleton className="h-10" />
        ) : prose?.text ? (
          <p className="whitespace-pre-wrap break-words border-l-2 border-accent/70 pl-2.5 text-[13px] leading-relaxed text-ink">
            {prose.text}
          </p>
        ) : (
          <p className="border-l-2 border-line pl-2.5 text-[12px] italic text-ink-faint">
            No human prose in this turn&apos;s opening request — it carried only harness-injected
            content.
          </p>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-2 flex cursor-pointer items-center gap-1 text-[11.5px] text-ink-faint transition-colors duration-(--dur-1) hover:text-ink"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          {open ? 'hide' : 'show'} the stream this caused
          {prose && prose.harnessBlocks > 0 ? (
            <span className="ml-1">
              · {prose.harnessBlocks} harness block{prose.harnessBlocks === 1 ? '' : 's'} arrived
              alongside your text
            </span>
          ) : null}
        </button>
      </div>

      {/* ------------------------------------------------------- the stream */}
      {open ? (
        <div className="bg-canvas/30">
          {/* Your instruction stays pinned while the stream scrolls under it. */}
          <div className="sticky top-0 z-10 border-b border-line/60 bg-surface/95 px-3.5 py-2 backdrop-blur">
            <div className="mb-0.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.09em] text-accent">
              <MessageSquare className="size-3" /> your input
            </div>
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-snug text-ink-dim">
              {prose?.text || '—'}
            </p>
          </div>
          <div className="space-y-2.5 px-3.5 py-3">
            {detail.isLoading ? (
              <Skeleton className="h-32" />
            ) : detail.data ? (
              <ExchangeStream exchanges={detail.data.exchanges} />
            ) : (
              <p className="text-[12px] text-warn">Could not load this turn.</p>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------- the list

export function TurnStream({ sessionId }: { sessionId: string }): React.ReactElement {
  const turns = useQuery({
    queryKey: ['session-turns', sessionId],
    queryFn: () => api.sessionTurns(sessionId, { limit: 200 }),
  });

  if (turns.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (turns.isError) {
    return (
      <EmptyState title="Could not load turns">
        The turn endpoint returned an error for this session.
      </EmptyState>
    );
  }
  const items = turns.data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState title="No turns recorded">
        This session has requests but no turn boundaries yet.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((t, i) => (
        <TurnBlock key={t.turnId} turn={t} index={i} />
      ))}
    </div>
  );
}
