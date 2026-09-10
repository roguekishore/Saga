import {
  type BlockContext,
  type ContentBlock,
  classifyBlocks,
  type NormalizedMessage,
} from '@saga/contracts';
import {
  Badge,
  BLOCK_CONTEXT_META,
  BlockContextTag,
  cn,
  describeMessageTime,
  fmtBytes,
  fmtTimeOrDate,
  InferredTag,
  Tip,
} from '@saga/ui';
import {
  Brain,
  ChevronRight,
  History,
  Image as ImageIcon,
  Lock,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';

/**
 * Block renderers. `thinking` is first-class here — this upstream really
 * streams it (thinking_delta + signature) and hiding it would be dishonest.
 */

const ROLE_TONE: Record<string, string> = {
  system: 'text-warn',
  user: 'text-info',
  assistant: 'text-ok',
  tool: 'text-inferred',
};

export function MessageCard({
  msg,
  title,
  requestTs,
}: {
  msg: NormalizedMessage;
  title?: string;
  /** This request's own `ts`, so a carried-over body can be told apart. */
  requestTs?: number;
}) {
  // Derived on read, never stored: block content feeds the dedup content hash,
  // so tagging blocks at write time would rewrite every hash. This also means
  // the labels apply retroactively to already-captured history.
  const blockCtx = classifyBlocks(msg.blocks, msg.role);
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line/60 px-3 py-1.5">
        <span
          className={cn('text-[11px] font-bold uppercase tracking-[0.1em]', ROLE_TONE[msg.role])}
        >
          {title ?? msg.role}
        </span>
        <Badge>{msg.contextSource}</Badge>
        {msg.contextSourceInferred ? <InferredTag what="memory" /> : null}
        <MessageTime firstObservedAt={msg.firstObservedAt} requestTs={requestTs} />
        <span className="ml-auto text-[10.5px] text-ink-faint">
          {msg.blocks.length} block{msg.blocks.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-2 p-2.5">
        {msg.blocks.map((b, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional; no stable id
          <LabeledBlock key={i} block={b} ctx={blockCtx[i]} />
        ))}
      </div>
    </div>
  );
}

/**
 * First-observed clock for one message. Deliberately NOT called "sent at":
 * dedup means this is the earliest sighting of this exact body. The turn-back
 * arrow marks a body that predates the request carrying it — context the
 * client replayed rather than new input.
 */
function MessageTime({
  firstObservedAt,
  requestTs,
}: {
  firstObservedAt: number | null | undefined;
  requestTs: number | undefined;
}) {
  const d = describeMessageTime(firstObservedAt, requestTs);
  if (!d || firstObservedAt == null) return null;
  return (
    <Tip content={d.explain}>
      <span
        className={cn(
          'inline-flex cursor-default items-center gap-1 font-mono text-[10.5px] tabular-nums',
          d.carriedOver ? 'text-ink-faint' : 'text-ink-dim',
        )}
      >
        {d.carriedOver ? <History className="size-3 opacity-70" /> : null}
        {fmtTimeOrDate(firstObservedAt, requestTs)}
      </span>
    </Tip>
  );
}

/**
 * One block plus its per-block label. This is the fix for the thing the wire
 * makes invisible: a typed sentence and an injected CLAUDE.md arrive in the same
 * user-role message, so without a label per block the card cannot say which is
 * which.
 *
 * Your prose gets the accent rail; injected scaffolding is visually demoted and
 * collapsed once it is long enough to bury the turn it was wrapped around.
 */
function LabeledBlock({ block, ctx }: { block: ContentBlock; ctx: BlockContext | undefined }) {
  // Declared before any early return: hooks must run in the same order on every
  // render, and the `!ctx` bail below would otherwise skip this one.
  const [open, setOpen] = useState(false);

  // No classification (index out of range should be impossible, but the type
  // admits it): render the block plainly rather than invent a label.
  if (!ctx) return <BlockView block={block} />;

  const meta = BLOCK_CONTEXT_META[ctx.kind];
  const isYours = meta.tone === 'you';
  const chars =
    block.type === 'text'
      ? block.text.length
      : block.type === 'thinking'
        ? block.thinking.length
        : 0;
  // Only injected noise collapses. Your own text is never hidden from you, and
  // model output has its own collapse behaviour in ThinkingView.
  const collapsible = meta.tone === 'injected' && chars > 1500;

  return (
    <div className={cn('rounded-md', isYours && 'border-l-2 border-accent/70 pl-2.5')}>
      <div className="mb-1 flex items-center gap-2">
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
            className="ml-auto cursor-pointer text-[10.5px] text-ink-faint hover:text-ink"
          >
            {open ? 'collapse' : 'expand'}
          </button>
        ) : null}
      </div>
      {collapsible && !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full cursor-pointer truncate rounded-md bg-canvas/40 px-3 py-2 text-left font-mono text-[11.5px] text-ink-faint hover:bg-canvas/60"
        >
          {block.type === 'text' ? block.text.slice(0, 160) : '…'}
        </button>
      ) : (
        <div className={cn(!isYours && meta.tone === 'injected' && 'opacity-80')}>
          <BlockView block={block} />
        </div>
      )}
    </div>
  );
}

export function BlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <pre className="whitespace-pre-wrap break-words rounded-md bg-canvas/60 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink">
          {block.text || <span className="text-ink-faint">(empty)</span>}
        </pre>
      );

    case 'thinking':
      return <ThinkingView thinking={block.thinking} signature={block.signature} />;

    case 'redacted_thinking':
      return (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-thinking/40 bg-thinking/5 px-3 py-2 text-[12px] text-thinking">
          <Lock className="size-3.5" />
          provider-encrypted reasoning ({fmtBytes(block.data.length)}) — opaque by design
        </div>
      );

    case 'tool_use':
      return (
        <div className="overflow-hidden rounded-md border border-line">
          <div className="flex items-center gap-2 bg-raised px-3 py-1.5">
            <Wrench className="size-3.5 text-accent" />
            <span className="font-mono text-[12px] font-semibold">{block.name}</span>
            <span className="font-mono text-[10.5px] text-ink-faint">{block.id}</span>
            {block.input === null && block.inputJson ? (
              <Tip content="The stream ended mid-JSON; SAGA keeps the raw partial instead of inventing a parse.">
                <span>
                  <Badge tone="warn">partial input</Badge>
                </span>
              </Tip>
            ) : null}
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all bg-canvas/60 px-3 py-2 font-mono text-[12px] leading-relaxed">
            {block.inputJson ?? '(no input)'}
          </pre>
        </div>
      );

    case 'tool_result':
      return (
        <div
          className={cn(
            'overflow-hidden rounded-md border',
            block.isError ? 'border-err/40' : 'border-line',
          )}
        >
          <div className="flex items-center gap-2 bg-raised px-3 py-1.5">
            <ChevronRight className="size-3.5 text-inferred" />
            <span className="text-[11.5px] font-medium text-ink-dim">tool result</span>
            <span className="font-mono text-[10.5px] text-ink-faint">for {block.toolUseId}</span>
            {block.isError ? <Badge tone="err">error</Badge> : null}
          </div>
          <div className="space-y-1.5 px-3 py-2">
            {block.content.length === 0 ? (
              <span className="text-[12px] text-ink-faint">(empty result)</span>
            ) : (
              block.content.map((c, i) =>
                c.type === 'text' ? (
                  <pre
                    // biome-ignore lint/suspicious/noArrayIndexKey: content items are positional
                    key={i}
                    className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed"
                  >
                    {c.text}
                  </pre>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: content items are positional
                  <ImagePlaceholder key={i} mediaType={c.mediaType} byteSize={c.byteSize} />
                ),
              )
            )}
          </div>
        </div>
      );

    case 'image':
      return <ImagePlaceholder mediaType={block.mediaType} byteSize={block.byteSize} />;

    case 'unknown':
      return (
        <div className="overflow-hidden rounded-md border border-warn/40">
          <div className="flex items-center gap-2 bg-warn/10 px-3 py-1.5">
            <TriangleAlert className="size-3.5 text-warn" />
            <span className="text-[11.5px] font-medium">
              unrecognized block <span className="font-mono">{block.rawType}</span>
            </span>
            <Tip content="This shape isn't in SAGA's contract yet. It was captured verbatim (redacted) instead of being dropped or force-fit — honesty over ceremony.">
              <span>
                <Badge tone="warn">preserved raw</Badge>
              </span>
            </Tip>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px]">
            {block.json}
          </pre>
        </div>
      );
  }
}

function ThinkingView({ thinking, signature }: { thinking: string; signature: string | null }) {
  const long = thinking.length > 700;
  const [open, setOpen] = useState(!long);
  return (
    <div className="overflow-hidden rounded-md border border-thinking/35 bg-thinking/[0.05]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left"
      >
        <Brain className="size-3.5 text-thinking" />
        <span className="text-[11.5px] font-semibold text-thinking">extended thinking</span>
        <span className="text-[10.5px] text-ink-faint">
          {thinking.length.toLocaleString()} chars
        </span>
        {signature ? (
          <Tip
            content={`Signed block — signature travels with the thinking verbatim.\n${signature.slice(0, 64)}…`}
          >
            <span>
              <Badge tone="inferred">signed</Badge>
            </span>
          </Tip>
        ) : null}
        <span className="ml-auto text-[10.5px] text-ink-faint">{open ? 'collapse' : 'expand'}</span>
      </button>
      {open ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-thinking/20 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-dim">
          {thinking}
        </pre>
      ) : null}
    </div>
  );
}

function ImagePlaceholder({
  mediaType,
  byteSize,
}: {
  mediaType: string | null;
  byteSize: number | null;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint">
      <ImageIcon className="size-3.5" />
      image — content not stored by policy
      <span className="font-mono text-[11px]">
        ({mediaType ?? 'unknown type'}
        {byteSize != null ? `, ~${fmtBytes(byteSize)}` : ''})
      </span>
    </div>
  );
}
