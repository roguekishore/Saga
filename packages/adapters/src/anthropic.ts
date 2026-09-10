import type {
  Adapter,
  AdapterRequestContext,
  ContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  ObserverResult,
  SseFrame,
  StreamObserver,
  ToolDefSummary,
  Usage,
  UsageValue,
} from '@saga/contracts';
import {
  type AdapterOptions,
  asRecord,
  asString,
  safeStringify,
  structuralContextSource,
  unknownBlock,
} from './shared';

/**
 * Anthropic Messages shape (`POST /v1/messages`) — the shape kiro-gateway
 * speaks natively and Claude Code emits.
 *
 * Stream grammar observed on the reference upstream (ground truth):
 * `message_start` (carries usage), `content_block_start`,
 * `content_block_delta` (`text_delta` | `thinking_delta` | `input_json_delta`
 * | `signature_delta`), `content_block_stop`, `message_delta` (stop_reason +
 * cumulative output usage), `message_stop`. `usage` is read off the frames,
 * NEVER recomputed here.
 */

function contentToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content))
    return content == null ? [] : [unknownBlock(content, typeof content)];
  const out: ContentBlock[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) {
      out.push(unknownBlock(item, typeof item));
      continue;
    }
    switch (rec.type) {
      case 'text':
        out.push({ type: 'text', text: asString(rec.text) ?? '' });
        break;
      case 'thinking':
        out.push({
          type: 'thinking',
          thinking: asString(rec.thinking) ?? '',
          signature: asString(rec.signature),
        });
        break;
      case 'redacted_thinking':
        out.push({ type: 'redacted_thinking', data: asString(rec.data) ?? '' });
        break;
      case 'tool_use':
        out.push({
          type: 'tool_use',
          id: asString(rec.id) ?? '',
          name: asString(rec.name) ?? '',
          input: rec.input ?? null,
          inputJson: rec.input === undefined ? null : safeStringify(rec.input),
        });
        break;
      case 'tool_result': {
        const inner = contentToBlocks(rec.content).filter(
          (b): b is Extract<ContentBlock, { type: 'text' | 'image' }> =>
            b.type === 'text' || b.type === 'image',
        );
        out.push({
          type: 'tool_result',
          toolUseId: asString(rec.tool_use_id) ?? '',
          isError: rec.is_error === true,
          content: inner,
        });
        break;
      }
      case 'image': {
        const source = asRecord(rec.source);
        const data = asString(source?.data);
        out.push({
          type: 'image',
          mediaType: asString(source?.media_type),
          byteSize: data ? Math.floor((data.length * 3) / 4) : null,
          note: 'content-not-stored',
        });
        break;
      }
      default:
        out.push(unknownBlock(rec, asString(rec.type) ?? 'untyped'));
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client's own session id, read off `metadata.user_id`.
 *
 * Claude Code sends that field as a JSON *string* holding
 * `{device_id, account_uuid, session_id}` (ground truth 2026-09-04, observed
 * on every `/v1/messages` call it makes). Only `session_id` is taken, and only
 * when it is uuid-shaped — a stray value must not become a session key. The
 * sibling `device_id` is a stable device fingerprint and is scrubbed by the
 * redact layer, never read here.
 *
 * Anything else — a plain-string `user_id`, absent metadata, another client —
 * yields null, and session correlation falls back to its heuristic.
 */
function clientSessionIdFrom(body: Record<string, unknown>): string | null {
  const raw = asString(asRecord(body.metadata)?.user_id);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // opaque user id, not Claude Code's envelope
  }
  const sid = asString(asRecord(parsed)?.session_id);
  return sid && UUID_RE.test(sid) ? sid : null;
}

function normalizeRequest(ctx: AdapterRequestContext): NormalizedRequest {
  const body = asRecord(ctx.body) ?? {};
  const model = asString(body.model);
  const stream = body.stream === true;

  const system: NormalizedMessage[] = [];
  if (typeof body.system === 'string') {
    system.push({
      role: 'system',
      blocks: [{ type: 'text', text: body.system }],
      contextSource: 'system',
      contextSourceInferred: false,
    });
  } else if (Array.isArray(body.system)) {
    system.push({
      role: 'system',
      blocks: contentToBlocks(body.system),
      contextSource: 'system',
      contextSourceInferred: false,
    });
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: NormalizedMessage[] = rawMessages.map((m, i) => {
    const rec = asRecord(m) ?? {};
    const role = rec.role === 'assistant' ? 'assistant' : 'user';
    const blocks = contentToBlocks(rec.content);
    const toolOnly = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    return {
      role,
      blocks,
      contextSource: structuralContextSource(i, rawMessages.length, role, toolOnly),
      contextSourceInferred: false,
    };
  });

  const tools: ToolDefSummary[] = (Array.isArray(body.tools) ? body.tools : []).flatMap((t) => {
    const rec = asRecord(t);
    if (!rec) return [];
    return [
      {
        name: asString(rec.name) ?? '(unnamed)',
        descriptionBytes: Buffer.byteLength(asString(rec.description) ?? '', 'utf-8'),
        inputSchemaBytes: Buffer.byteLength(safeStringify(rec.input_schema ?? null), 'utf-8'),
      },
    ];
  });

  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!['messages', 'system', 'tools'].includes(k)) params[k] = v;
  }

  return {
    model,
    stream,
    system,
    messages,
    tools,
    paramsJson: safeStringify(params),
    rawRequestJson: safeStringify(body),
    clientSessionId: clientSessionIdFrom(body),
  };
}

interface OpenBlock {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'unknown';
  rawType: string;
  text: string;
  signature: string | null;
  toolId: string;
  toolName: string;
  inputJson: string;
  raw: unknown;
}

class AnthropicObserver implements StreamObserver {
  private readonly usageSource: AdapterOptions['usageSource'];
  private readonly blocks = new Map<number, OpenBlock>();
  private usage: Usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  private stopReason: string | null = null;
  private errorInfo: { type: string; message: string } | null = null;
  private sawContent = false;
  private frames = 0;
  private bytes = 0;
  private parseErrors = 0;
  private pendingDelta: {
    blockType: 'text' | 'thinking' | 'tool_use' | 'unknown';
    chars: number;
  } | null = null;
  private completedTools: Array<{
    blockIndex: number;
    toolUseId: string;
    name: string;
    inputJson: string | null;
  }> = [];
  private complete = false;

  constructor(opts: AdapterOptions) {
    this.usageSource = opts.usageSource;
  }

  private uv(v: unknown): UsageValue | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? { value: Math.floor(v), source: this.usageSource }
      : null;
  }

  private trackDelta(blockType: 'text' | 'thinking' | 'tool_use' | 'unknown', chars: number): void {
    this.sawContent = true;
    if (this.pendingDelta && this.pendingDelta.blockType === blockType) {
      this.pendingDelta.chars += chars;
    } else {
      this.pendingDelta = { blockType, chars };
    }
  }

  onFrame(frame: SseFrame): void {
    this.frames++;
    this.bytes += frame.data.length;
    const j = asRecord(frame.json);
    if (!j) {
      if (frame.data !== '' && frame.data !== '[DONE]') this.parseErrors++;
      return;
    }
    switch (j.type) {
      case 'message_start': {
        const message = asRecord(j.message);
        const usage = asRecord(message?.usage);
        if (usage) {
          this.usage.input = this.uv(usage.input_tokens);
          this.usage.output = this.uv(usage.output_tokens) ?? this.usage.output;
          this.usage.cacheRead = this.uv(usage.cache_read_input_tokens);
          this.usage.cacheWrite = this.uv(usage.cache_creation_input_tokens);
        }
        break;
      }
      case 'content_block_start': {
        const idx = typeof j.index === 'number' ? j.index : this.blocks.size;
        const cb = asRecord(j.content_block) ?? {};
        const rawType = asString(cb.type) ?? 'untyped';
        const type =
          rawType === 'text' ||
          rawType === 'thinking' ||
          rawType === 'redacted_thinking' ||
          rawType === 'tool_use'
            ? rawType
            : 'unknown';
        this.blocks.set(idx, {
          type,
          rawType,
          text: rawType === 'redacted_thinking' ? (asString(cb.data) ?? '') : '',
          signature: null,
          toolId: asString(cb.id) ?? '',
          toolName: asString(cb.name) ?? '',
          inputJson: '',
          raw: cb,
        });
        if (type === 'tool_use') this.trackDelta('tool_use', 0);
        break;
      }
      case 'content_block_delta': {
        const idx = typeof j.index === 'number' ? j.index : -1;
        const block = this.blocks.get(idx);
        const delta = asRecord(j.delta);
        if (!block || !delta) break;
        switch (delta.type) {
          case 'text_delta': {
            const t = asString(delta.text) ?? '';
            block.text += t;
            this.trackDelta('text', t.length);
            break;
          }
          case 'thinking_delta': {
            const t = asString(delta.thinking) ?? '';
            block.text += t;
            this.trackDelta('thinking', t.length);
            break;
          }
          case 'input_json_delta': {
            const t = asString(delta.partial_json) ?? '';
            block.inputJson += t;
            this.trackDelta('tool_use', t.length);
            break;
          }
          case 'signature_delta':
            block.signature = (block.signature ?? '') + (asString(delta.signature) ?? '');
            break;
          default:
            this.trackDelta('unknown', frame.data.length);
        }
        break;
      }
      case 'message_delta': {
        const delta = asRecord(j.delta);
        if (delta) this.stopReason = asString(delta.stop_reason) ?? this.stopReason;
        const usage = asRecord(j.usage);
        if (usage) {
          const out = this.uv(usage.output_tokens);
          if (out) this.usage.output = out;
        }
        break;
      }
      case 'message_stop':
        this.complete = true;
        break;
      case 'error': {
        const err = asRecord(j.error);
        this.errorInfo = {
          type: asString(err?.type) ?? 'error',
          message: asString(err?.message) ?? frame.data.slice(0, 300),
        };
        break;
      }
      case 'content_block_stop': {
        const idx = typeof j.index === 'number' ? j.index : -1;
        const block = this.blocks.get(idx);
        if (block?.type === 'tool_use') {
          this.completedTools.push({
            blockIndex: idx,
            toolUseId: block.toolId,
            name: block.toolName,
            inputJson: block.inputJson || null,
          });
        }
        break;
      }
      case 'ping':
        break;
      default:
        break;
    }
  }

  onCompleteBody(body: unknown): void {
    const j = asRecord(body);
    if (!j) return;
    this.frames++;
    if (j.type === 'error') {
      const err = asRecord(j.error);
      this.errorInfo = {
        type: asString(err?.type) ?? 'error',
        message: asString(err?.message) ?? 'upstream error',
      };
      return;
    }
    const blocks = contentToBlocks(j.content);
    blocks.forEach((b, i) => {
      this.blocks.set(i, {
        type:
          b.type === 'text' ||
          b.type === 'thinking' ||
          b.type === 'redacted_thinking' ||
          b.type === 'tool_use'
            ? b.type
            : 'unknown',
        rawType: b.type,
        text:
          b.type === 'text'
            ? b.text
            : b.type === 'thinking'
              ? b.thinking
              : b.type === 'redacted_thinking'
                ? b.data
                : '',
        signature: b.type === 'thinking' ? b.signature : null,
        toolId: b.type === 'tool_use' ? b.id : '',
        toolName: b.type === 'tool_use' ? b.name : '',
        inputJson: b.type === 'tool_use' ? (b.inputJson ?? '') : '',
        raw: b,
      });
    });
    if (blocks.length > 0) this.sawContent = true;
    const usage = asRecord(j.usage);
    if (usage) {
      this.usage.input = this.uv(usage.input_tokens);
      this.usage.output = this.uv(usage.output_tokens);
      this.usage.cacheRead = this.uv(usage.cache_read_input_tokens);
      this.usage.cacheWrite = this.uv(usage.cache_creation_input_tokens);
    }
    this.stopReason = asString(j.stop_reason);
    this.complete = true;
  }

  sawFirstContent(): boolean {
    return this.sawContent;
  }

  outputTokensSoFar(): { value: number; source: 'upstream-reported' | 'gateway-computed' } | null {
    return this.usage.output ? { value: this.usage.output.value, source: this.usageSource } : null;
  }

  deltaSinceLastPoll(): {
    blockType: 'text' | 'thinking' | 'tool_use' | 'unknown';
    chars: number;
  } | null {
    const d = this.pendingDelta;
    this.pendingDelta = null;
    return d;
  }

  drainCompletedToolUses(): Array<{
    blockIndex: number;
    toolUseId: string;
    name: string;
    inputJson: string | null;
  }> {
    const out = this.completedTools;
    this.completedTools = [];
    return out;
  }

  finalize(reason: 'complete' | 'client_aborted' | 'upstream_error'): ObserverResult {
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]);
    const blocks: ContentBlock[] = [];
    const toolUses: ObserverResult['toolUses'] = [];
    for (const [idx, b] of ordered) {
      switch (b.type) {
        case 'text':
          blocks.push({ type: 'text', text: b.text });
          break;
        case 'thinking':
          blocks.push({ type: 'thinking', thinking: b.text, signature: b.signature });
          break;
        case 'redacted_thinking':
          blocks.push({ type: 'redacted_thinking', data: b.text });
          break;
        case 'tool_use': {
          let input: unknown = null;
          try {
            input = b.inputJson ? JSON.parse(b.inputJson) : null;
          } catch {
            input = null; // aborted mid-JSON; raw partial preserved below
          }
          blocks.push({
            type: 'tool_use',
            id: b.toolId,
            name: b.toolName,
            input,
            inputJson: b.inputJson || null,
          });
          toolUses.push({
            blockIndex: idx,
            toolUseId: b.toolId,
            name: b.toolName,
            inputJson: b.inputJson || null,
          });
          break;
        }
        case 'unknown':
          blocks.push(unknownBlock(b.raw, b.rawType));
          break;
      }
    }
    const message: NormalizedMessage | null =
      blocks.length > 0
        ? {
            role: 'assistant',
            blocks,
            contextSource: 'assistant',
            contextSourceInferred: false,
          }
        : null;
    if (reason !== 'complete' && !this.complete && this.stopReason == null) {
      this.stopReason = reason === 'client_aborted' ? 'client_aborted' : null;
    }
    return {
      usage: this.usage,
      stopReason: this.stopReason,
      message,
      toolUses,
      frameStats: { frames: this.frames, bytes: this.bytes, parseErrors: this.parseErrors },
    };
  }

  get error(): { type: string; message: string } | null {
    return this.errorInfo;
  }
}

export function anthropicAdapter(opts: AdapterOptions): Adapter {
  return {
    id: 'anthropic',
    provider: 'anthropic-messages',
    displayName: 'Anthropic Messages',
    matches(ctx: AdapterRequestContext): boolean {
      const p = ctx.path.split('?')[0] ?? '';
      return ctx.method === 'POST' && (p === '/v1/messages' || p.endsWith('/v1/messages'));
    },
    normalizeRequest,
    createObserver(): StreamObserver {
      return new AnthropicObserver(opts);
    },
  };
}
