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
 * OpenAI Chat Completions shape (`POST /v1/chat/completions`) — the second
 * dialect the reference upstream answers. Two adapters against one upstream
 * proves the adapter abstraction now, not at provider #2.
 *
 * Stream grammar: `data:` chunks with `choices[].delta` carrying `content`,
 * `reasoning_content` (thinking on several gateways), and incremental
 * `tool_calls`; a final `data: [DONE]`. Usage rides the last chunk only when
 * the client asked via `stream_options.include_usage`.
 */

function partsToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content.length ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content))
    return content == null ? [] : [unknownBlock(content, typeof content)];
  const out: ContentBlock[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec) {
      out.push(unknownBlock(part, typeof part));
      continue;
    }
    if (rec.type === 'text') {
      out.push({ type: 'text', text: asString(rec.text) ?? '' });
    } else if (rec.type === 'image_url') {
      const img = asRecord(rec.image_url);
      const url = asString(img?.url) ?? '';
      const isData = url.startsWith('data:');
      out.push({
        type: 'image',
        mediaType: isData ? (url.slice(5).split(';')[0] ?? null) : 'url',
        byteSize: isData ? Math.floor((url.length * 3) / 4) : null,
        note: 'content-not-stored',
      });
    } else {
      out.push(unknownBlock(rec, asString(rec.type) ?? 'untyped'));
    }
  }
  return out;
}

function normalizeRequest(ctx: AdapterRequestContext): NormalizedRequest {
  const body = asRecord(ctx.body) ?? {};
  const model = asString(body.model);
  const stream = body.stream === true;

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const system: NormalizedMessage[] = [];
  const chat: Array<{ rec: Record<string, unknown>; role: NormalizedMessage['role'] }> = [];

  for (const m of rawMessages) {
    const rec = asRecord(m) ?? {};
    const rawRole = asString(rec.role) ?? 'user';
    if (rawRole === 'system' || rawRole === 'developer') {
      system.push({
        role: 'system',
        blocks: partsToBlocks(rec.content),
        contextSource: 'system',
        contextSourceInferred: false,
      });
    } else {
      chat.push({
        rec,
        role: rawRole === 'assistant' ? 'assistant' : rawRole === 'tool' ? 'tool' : 'user',
      });
    }
  }

  const messages: NormalizedMessage[] = chat.map(({ rec, role }, i) => {
    let blocks: ContentBlock[];
    if (role === 'tool') {
      blocks = [
        {
          type: 'tool_result',
          toolUseId: asString(rec.tool_call_id) ?? '',
          isError: false,
          content: partsToBlocks(rec.content).filter(
            (b): b is Extract<ContentBlock, { type: 'text' | 'image' }> =>
              b.type === 'text' || b.type === 'image',
          ),
        },
      ];
    } else {
      blocks = partsToBlocks(rec.content);
      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          const t = asRecord(tc);
          const fn = asRecord(t?.function);
          const args = asString(fn?.arguments);
          let input: unknown = null;
          try {
            input = args ? JSON.parse(args) : null;
          } catch {
            input = null;
          }
          blocks.push({
            type: 'tool_use',
            id: asString(t?.id) ?? '',
            name: asString(fn?.name) ?? '',
            input,
            inputJson: args,
          });
        }
      }
    }
    const toolOnly = role === 'tool';
    return {
      role,
      blocks,
      contextSource: structuralContextSource(i, chat.length, role, toolOnly),
      contextSourceInferred: false,
    };
  });

  const tools: ToolDefSummary[] = (Array.isArray(body.tools) ? body.tools : []).flatMap((t) => {
    const rec = asRecord(t);
    const fn = asRecord(rec?.function);
    if (!fn) return [];
    return [
      {
        name: asString(fn.name) ?? '(unnamed)',
        descriptionBytes: Buffer.byteLength(asString(fn.description) ?? '', 'utf-8'),
        inputSchemaBytes: Buffer.byteLength(safeStringify(fn.parameters ?? null), 'utf-8'),
      },
    ];
  });

  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!['messages', 'tools'].includes(k)) params[k] = v;
  }

  return {
    model,
    stream,
    system,
    messages,
    tools,
    paramsJson: safeStringify(params),
    rawRequestJson: safeStringify(body),
    // The chat-completions shape has no session field. `user` is a free-form
    // end-user id, not a conversation id, so it is deliberately NOT used here.
    clientSessionId: null,
  };
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

class OpenAiObserver implements StreamObserver {
  private readonly usageSource: AdapterOptions['usageSource'];
  private text = '';
  private reasoning = '';
  private toolCalls = new Map<number, ToolCallAcc>();
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

  private readUsage(usage: Record<string, unknown>): void {
    const input = this.uv(usage.prompt_tokens);
    const output = this.uv(usage.completion_tokens);
    if (input) this.usage.input = input;
    if (output) this.usage.output = output;
    const details = asRecord(usage.prompt_tokens_details);
    const cached = this.uv(details?.cached_tokens);
    if (cached) this.usage.cacheRead = cached;
  }

  onFrame(frame: SseFrame): void {
    this.frames++;
    this.bytes += frame.data.length;
    if (frame.data === '[DONE]') return;
    const j = asRecord(frame.json);
    if (!j) {
      if (frame.data !== '') this.parseErrors++;
      return;
    }
    const err = asRecord(j.error);
    if (err) {
      this.errorInfo = {
        type: asString(err.type) ?? 'error',
        message: asString(err.message) ?? frame.data.slice(0, 300),
      };
      return;
    }
    const choice = Array.isArray(j.choices) ? asRecord(j.choices[0]) : null;
    if (choice) {
      const delta = asRecord(choice.delta);
      if (delta) {
        const content = asString(delta.content);
        if (content) {
          this.text += content;
          this.trackDelta('text', content.length);
        }
        const reasoning = asString(delta.reasoning_content);
        if (reasoning) {
          this.reasoning += reasoning;
          this.trackDelta('thinking', reasoning.length);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const t = asRecord(tc);
            if (!t) continue;
            const idx = typeof t.index === 'number' ? t.index : 0;
            const acc = this.toolCalls.get(idx) ?? { id: '', name: '', args: '' };
            const fn = asRecord(t.function);
            acc.id = asString(t.id) ?? acc.id;
            acc.name = (acc.name + '').length ? acc.name : (asString(fn?.name) ?? acc.name);
            const argDelta = asString(fn?.arguments) ?? '';
            acc.args += argDelta;
            this.toolCalls.set(idx, acc);
            this.trackDelta('tool_use', argDelta.length);
          }
        }
      }
      const fin = asString(choice.finish_reason);
      if (fin) this.stopReason = fin;
    }
    const usage = asRecord(j.usage);
    if (usage) this.readUsage(usage);
  }

  onCompleteBody(body: unknown): void {
    const j = asRecord(body);
    if (!j) return;
    this.frames++;
    const err = asRecord(j.error);
    if (err) {
      this.errorInfo = {
        type: asString(err.type) ?? 'error',
        message: asString(err.message) ?? 'upstream error',
      };
      return;
    }
    const choice = Array.isArray(j.choices) ? asRecord(j.choices[0]) : null;
    const msg = asRecord(choice?.message);
    if (msg) {
      this.text = asString(msg.content) ?? '';
      this.reasoning = asString(msg.reasoning_content) ?? '';
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc, i) => {
          const t = asRecord(tc);
          const fn = asRecord(t?.function);
          this.toolCalls.set(i, {
            id: asString(t?.id) ?? '',
            name: asString(fn?.name) ?? '',
            args: asString(fn?.arguments) ?? '',
          });
        });
      }
      this.sawContent =
        this.text.length > 0 || this.reasoning.length > 0 || this.toolCalls.size > 0;
    }
    this.stopReason = asString(choice?.finish_reason);
    const usage = asRecord(j.usage);
    if (usage) this.readUsage(usage);
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

  finalize(reason: 'complete' | 'client_aborted' | 'upstream_error'): ObserverResult {
    const blocks: ContentBlock[] = [];
    if (this.reasoning)
      blocks.push({ type: 'thinking', thinking: this.reasoning, signature: null });
    if (this.text) blocks.push({ type: 'text', text: this.text });
    const toolUses: ObserverResult['toolUses'] = [];
    let blockIndex = blocks.length;
    for (const [, acc] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = null;
      try {
        input = acc.args ? JSON.parse(acc.args) : null;
      } catch {
        input = null;
      }
      blocks.push({
        type: 'tool_use',
        id: acc.id,
        name: acc.name,
        input,
        inputJson: acc.args || null,
      });
      toolUses.push({
        blockIndex: blockIndex++,
        toolUseId: acc.id,
        name: acc.name,
        inputJson: acc.args || null,
      });
    }
    const message: NormalizedMessage | null =
      blocks.length > 0
        ? { role: 'assistant', blocks, contextSource: 'assistant', contextSourceInferred: false }
        : null;
    if (reason === 'client_aborted' && this.stopReason == null) this.stopReason = 'client_aborted';
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

export function openaiAdapter(opts: AdapterOptions): Adapter {
  return {
    id: 'openai',
    provider: 'openai-chat',
    displayName: 'OpenAI Chat Completions',
    matches(ctx: AdapterRequestContext): boolean {
      const p = ctx.path.split('?')[0] ?? '';
      return ctx.method === 'POST' && p.endsWith('/v1/chat/completions');
    },
    normalizeRequest,
    createObserver(): StreamObserver {
      return new OpenAiObserver(opts);
    },
  };
}
