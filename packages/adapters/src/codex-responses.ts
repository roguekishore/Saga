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
 * Codex `/v1/responses` (door A).
 *
 * Spec: `docs/ws-c/C2-codex-adapter.md`. Wire detail:
 * `D:/PROJECTS/AI/analysis/FINDINGS-codex.md` (authoritative, outranks spec).
 *
 * NOT the existing `openai.ts` adapter — that speaks `/v1/chat/completions`,
 * a different endpoint with a different body shape. Do not conflate them.
 *
 * Identity trap: the `session-id` HEADER is the prompt-cache key, NOT the
 * session. The authoritative session id lives at
 * `body.client_metadata.session_id`. Grouping on the header silently merges
 * unrelated conversations and splits real ones. See FINDINGS §1.4 / §2.2.
 *
 * Stream grammar: SSE with event names in the OpenAI Responses idiom. Terminal
 * sentinel is `response.completed` (carries usage). Failures arrive as
 * `response.failed` / `response.incomplete`. Provenance here is always
 * `gateway-computed` — the upstream is CONDUIT, not OpenAI. `usageSource`
 * is taken from `AdapterOptions` and never hard-coded.
 */

// ---------------------------------------------------------------------------
// Injection detection helpers
// ---------------------------------------------------------------------------

const TAG_USER_INSTRUCTIONS = '<user_instructions>';
const TAG_ENV_CONTEXT = '<environment_context>';
// Diff-specific markers: partial env blocks carry status="unavailable" or
// lack the full <cwd>/<shell>/etc. structure a first-turn block always has.
const TAG_ENV_DIFF_MARKER = 'status="unavailable"';
const TAG_COMPACTION_TYPES = new Set(['compaction', 'context_compaction', 'compaction_trigger']);

/** Extract the combined text from a content value (string | block[]). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const r = asRecord(c);
      if (!r) return '';
      if (typeof r.text === 'string') return r.text;
      return '';
    })
    .join('');
}

interface InjectionTag {
  type: string;
  location: string | null;
  detail: string | null;
}

/**
 * Walk `input[]` items and emit observable injection tags.
 *
 * Tags: `user_instructions`, `environment_context`, `environment_context:diff`
 * (partial per-turn block — spread across requests), `responses_lite_prefix`,
 * `reasoning_encrypted`, `compaction`.
 *
 * The `environment_context:diff` tag is surfaced separately from
 * `environment_context` because it signals that the model's picture of the
 * workspace is spread across multiple requests in the turn — a single request
 * is by design incomplete. Readers and any per-request analysis must know this.
 */
function detectInjections(
  input: unknown[],
  headers: Record<string, string | string[] | undefined>,
): InjectionTag[] {
  const tags: InjectionTag[] = [];

  // responses_lite_prefix: the lite dialect is announced by a header, not body content.
  const liteHeader = asString(
    Array.isArray(headers['x-openai-internal-codex-responses-lite'])
      ? (headers['x-openai-internal-codex-responses-lite'] as string[])[0]
      : headers['x-openai-internal-codex-responses-lite'],
  );
  if (liteHeader === 'true') {
    tags.push({ type: 'responses_lite_prefix', location: 'input', detail: null });
  }

  for (let i = 0; i < input.length; i++) {
    const item = asRecord(input[i]);
    if (!item) continue;
    const itemType = asString(item.type) ?? '';

    // compaction items are a distinct type, not text content to scan.
    if (TAG_COMPACTION_TYPES.has(itemType)) {
      tags.push({ type: 'compaction', location: `input[${i}]`, detail: null });
      continue;
    }

    // reasoning items with encrypted_content.
    if (itemType === 'reasoning' || itemType === 'Reasoning') {
      if (item.encrypted_content != null) {
        tags.push({ type: 'reasoning_encrypted', location: `input[${i}]`, detail: null });
      }
      continue;
    }

    // message items: scan text for injection markers.
    if (itemType === 'message') {
      const role = asString(item.role) ?? '';
      if (role !== 'user' && role !== 'developer') continue;

      const text = contentText(item.content);
      if (!text) continue;

      if (text.includes(TAG_USER_INSTRUCTIONS)) {
        tags.push({ type: 'user_instructions', location: `input[${i}]`, detail: null });
      }

      if (text.includes(TAG_ENV_CONTEXT)) {
        // Determine full vs. diff: diff blocks carry status="unavailable" or
        // lack the mandatory <cwd> field that every full render includes.
        const isDiff =
          text.includes(TAG_ENV_DIFF_MARKER) ||
          (!text.includes('<cwd>') && !text.includes('<environments>'));
        if (isDiff) {
          // Surface loudly: means what the model knew is spread across requests.
          tags.push({
            type: 'environment_context:diff',
            location: `input[${i}]`,
            detail: 'partial-per-turn-block',
          });
        } else {
          tags.push({ type: 'environment_context', location: `input[${i}]`, detail: null });
        }
      }
    }
  }

  return tags;
}

// ---------------------------------------------------------------------------
// Input item → NormalizedMessage conversion
// ---------------------------------------------------------------------------

function itemContentToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) {
    return content == null ? [] : [unknownBlock(content, typeof content)];
  }
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
      case 'image_url':
      case 'image': {
        out.push({ type: 'image', mediaType: null, byteSize: null, note: 'content-not-stored' });
        break;
      }
      default:
        out.push(unknownBlock(rec, asString(rec.type) ?? 'untyped'));
    }
  }
  return out;
}

/**
 * Convert `input[]` items into NormalizedMessages.
 *
 * Item types handled:
 * - `message` — ordinary user/assistant turn
 * - `function_call` — model-side tool call → assistant message with tool_use block
 * - `function_call_output` — tool result (TOP-LEVEL item, unlike Gemini nesting) → tool message
 * - `reasoning` — may carry `encrypted_content` → redacted_thinking block in assistant message
 * - others → unknown block
 *
 * Context sourcing follows the structural rule: earlier items are history,
 * last item is user/assistant/tool; tool-only items are 'tool'.
 */
function inputItemsToMessages(input: unknown[]): NormalizedMessage[] {
  if (!Array.isArray(input) || input.length === 0) return [];

  const messages: NormalizedMessage[] = [];

  for (let i = 0; i < input.length; i++) {
    const item = asRecord(input[i]);
    if (!item) continue;
    const itemType = asString(item.type) ?? '';

    // Skip injection/context items and compaction items — they are not conversation turns.
    if (TAG_COMPACTION_TYPES.has(itemType)) continue;

    switch (itemType) {
      case 'message': {
        const rawRole = asString(item.role) ?? 'user';
        const role: NormalizedMessage['role'] =
          rawRole === 'assistant' ? 'assistant' : rawRole === 'system' ? 'system' : 'user';
        const blocks = itemContentToBlocks(item.content);
        const toolOnly = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
        messages.push({
          role,
          blocks,
          contextSource: structuralContextSource(i, input.length, role, toolOnly),
          contextSourceInferred: false,
        });
        break;
      }

      case 'function_call': {
        // Model-side tool invocation → tool_use block in an assistant message.
        const callId = asString(item.call_id) ?? asString(item.id) ?? '';
        const name = asString(item.name) ?? '';
        // arguments is a JSON-encoded string per FINDINGS §1.5
        const argsRaw = asString(item.arguments) ?? 'null';
        let input: unknown = null;
        try {
          input = JSON.parse(argsRaw);
        } catch {
          input = null;
        }
        const block: ContentBlock = {
          type: 'tool_use',
          id: callId,
          name,
          input,
          inputJson: argsRaw,
        };
        messages.push({
          role: 'assistant',
          blocks: [block],
          contextSource: structuralContextSource(i, input.length, 'assistant', false),
          contextSourceInferred: false,
        });
        break;
      }

      case 'function_call_output': {
        // TOP-LEVEL tool result item — unlike Gemini's nesting inside a Content.
        const callId = asString(item.call_id) ?? asString(item.id) ?? '';
        const outputText = typeof item.output === 'string' ? item.output : safeStringify(item.output);
        const block: ContentBlock = {
          type: 'tool_result',
          toolUseId: callId,
          isError: item.is_error === true,
          content: [{ type: 'text', text: outputText }],
        };
        messages.push({
          role: 'tool',
          blocks: [block],
          contextSource: 'tool',
          contextSourceInferred: false,
        });
        break;
      }

      case 'reasoning': {
        // May carry `encrypted_content` — opaque reasoning blob. Map to
        // `redacted_thinking` (the block exists precisely for reasoning SAGA
        // cannot read). A `summary` array carries readable text, if present.
        const blocks: ContentBlock[] = [];
        if (item.encrypted_content != null) {
          blocks.push({
            type: 'redacted_thinking',
            data: asString(item.encrypted_content) ?? '',
          });
        } else if (Array.isArray(item.summary) && item.summary.length > 0) {
          // Readable summary available.
          for (const s of item.summary) {
            const sr = asRecord(s);
            const text = asString(sr?.text) ?? asString(s) ?? '';
            if (text) blocks.push({ type: 'thinking', thinking: text, signature: null });
          }
        }
        if (blocks.length > 0) {
          messages.push({
            role: 'assistant',
            blocks,
            contextSource: structuralContextSource(i, input.length, 'assistant', false),
            contextSourceInferred: false,
          });
        }
        break;
      }

      default:
        // Unknown item type: preserve as unknown block.
        if (itemType) {
          messages.push({
            role: 'user',
            blocks: [unknownBlock(item, itemType)],
            contextSource: structuralContextSource(i, input.length, 'user', false),
            contextSourceInferred: true,
          });
        }
        break;
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

class CodexResponsesObserver implements StreamObserver {
  private readonly usageSource: AdapterOptions['usageSource'];
  private usage: Usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  private stopReason: string | null = null;
  private sawContent = false;
  private frames = 0;
  private bytes = 0;
  private parseErrors = 0;
  private complete = false;
  private toolUseList: ObserverResult['toolUses'] = [];

  constructor(opts: AdapterOptions) {
    this.usageSource = opts.usageSource;
  }

  private uv(v: unknown): UsageValue | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? { value: Math.floor(v), source: this.usageSource }
      : null;
  }

  onFrame(frame: SseFrame): void {
    this.frames++;
    this.bytes += frame.data.length;
    const j = asRecord(frame.json);
    if (!j) {
      if (frame.data !== '' && frame.data !== '[DONE]') this.parseErrors++;
      return;
    }

    // Codex terminal sentinel: `response.completed` carries token usage.
    // FINDINGS §1.7: verified at `sse/responses.rs:486-497`.
    const eventType = asString(j.type) ?? frame.event ?? '';

    switch (eventType) {
      case 'response.completed': {
        this.complete = true;
        // Usage is nested under `response.usage` or at top-level `usage`.
        const response = asRecord(j.response);
        const usageRec = asRecord(response?.usage ?? j.usage);
        if (usageRec) {
          this.usage.input = this.uv(usageRec.input_tokens);
          this.usage.output = this.uv(usageRec.output_tokens);
          // Cache fields per FINDINGS §1.7 token usage shape.
          const details = asRecord(usageRec.input_tokens_details);
          this.usage.cacheRead = this.uv(details?.cached_tokens);
          this.usage.cacheWrite = this.uv(details?.cache_write_tokens);
        }
        if (!this.stopReason) this.stopReason = 'completed';
        break;
      }

      case 'response.failed': {
        // Failure terminal — extract error code as stop reason.
        const response = asRecord(j.response);
        const error = asRecord(response?.error ?? j.error);
        this.stopReason = asString(error?.code) ?? asString(error?.type) ?? 'failed';
        break;
      }

      case 'response.incomplete': {
        const response = asRecord(j.response);
        const reason = asString(asRecord(response?.incomplete_details)?.reason);
        this.stopReason = reason ?? 'incomplete';
        break;
      }

      // Content events — track that something arrived.
      case 'response.output_text.delta':
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
      case 'response.mcp_call_arguments.delta':
      case 'response.refusal.delta':
        this.sawContent = true;
        break;

      // Tool call completion: surface the tool use.
      case 'response.output_item.done': {
        const item = asRecord(j.item);
        if (item && asString(item.type) === 'function_call') {
          const callId = asString(item.call_id) ?? asString(item.id) ?? '';
          const name = asString(item.name) ?? '';
          const inputJson = asString(item.arguments) ?? null;
          this.toolUseList.push({
            blockIndex: this.toolUseList.length,
            toolUseId: callId,
            name,
            inputJson,
          });
          this.sawContent = true;
        }
        break;
      }

      case 'response.content_part.done': {
        const part = asRecord(j.part);
        if (part && asString(part.type) === 'text' && asString(part.text)) {
          this.sawContent = true;
        }
        break;
      }

      default:
        break;
    }
  }

  onCompleteBody(body: unknown): void {
    this.frames++;
    const j = asRecord(body);
    if (!j) return;
    // Non-streaming response body (rare for Codex since stream:true is hardcoded,
    // but handle defensively per adapter contract).
    const usageRec = asRecord(j.usage);
    if (usageRec) {
      this.usage.input = this.uv(usageRec.input_tokens);
      this.usage.output = this.uv(usageRec.output_tokens);
      const details = asRecord(usageRec.input_tokens_details);
      this.usage.cacheRead = this.uv(details?.cached_tokens);
      this.usage.cacheWrite = this.uv(details?.cache_write_tokens);
    }
    if (!this.stopReason) {
      this.stopReason = asString(j.status) ?? null;
    }
    this.complete = true;
  }

  sawFirstContent(): boolean {
    return this.sawContent;
  }

  outputTokensSoFar(): { value: number; source: 'upstream-reported' | 'gateway-computed' } | null {
    return this.usage.output
      ? { value: this.usage.output.value, source: this.usageSource }
      : null;
  }

  finalize(reason: 'complete' | 'client_aborted' | 'upstream_error'): ObserverResult {
    if (reason !== 'complete' && !this.complete && this.stopReason == null) {
      this.stopReason = reason === 'client_aborted' ? 'client_aborted' : null;
    }
    return {
      usage: this.usage,
      stopReason: this.stopReason,
      message: null, // Response body content is not assembled frame-by-frame here
      toolUses: this.toolUseList,
      frameStats: { frames: this.frames, bytes: this.bytes, parseErrors: this.parseErrors },
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function codexResponsesAdapter(opts: AdapterOptions): Adapter {
  return {
    id: 'codex-responses',
    provider: 'openai-responses',
    displayName: 'Codex Responses',

    /**
     * Match `POST …/responses`. Path ends with `/responses` or contains
     * `/v1/responses`. Explicitly reject `/v1/chat/completions` and
     * `/v1/messages` to avoid mis-claiming those shapes.
     *
     * The `originator: codex_cli_rs` header corroborates Codex when present but
     * is only sent when non-default — absence is NOT evidence of not-Codex.
     * A matcher that requires it drops real traffic to passthrough.
     */
    matches(ctx: AdapterRequestContext): boolean {
      if (ctx.method !== 'POST') return false;
      const p = (ctx.path ?? '').split('?')[0];
      // Explicitly reject the other two AI endpoints.
      if (p.includes('/chat/completions') || p.endsWith('/v1/messages') || p === '/v1/messages') {
        return false;
      }
      return p.endsWith('/responses') || p.includes('/v1/responses');
    },

    /**
     * Normalize a Codex Responses body.
     *
     * Body shape: `input[]` items (NOT `messages[]`), `instructions` for the
     * system prompt (NOT `system`). All four identity fields come from
     * `client_metadata` in the body — the `session-id` HEADER is NOT the
     * session; it is the prompt-cache key (FINDINGS §1.4).
     */
    normalizeRequest(ctx: AdapterRequestContext): NormalizedRequest {
      try {
        const body = asRecord(ctx.body) ?? {};
        const headers = (ctx.headers ?? {}) as Record<string, string | string[] | undefined>;

        const model = asString(body.model);
        const stream = body.stream !== false; // hardcoded true in Codex, but be safe

        // System prompt: top-level `instructions` string.
        // Responses Lite: prompt may also be relocated into input[] as a developer-role
        // message item — detected by the `x-openai-internal-codex-responses-lite` header.
        const system: NormalizedMessage[] = [];
        const instructionsStr = asString(body.instructions);
        if (instructionsStr && instructionsStr.length > 0) {
          system.push({
            role: 'system',
            blocks: [{ type: 'text', text: instructionsStr }],
            contextSource: 'system',
            contextSourceInferred: false,
          });
        }

        const rawInput = Array.isArray(body.input) ? body.input : [];
        const messages = inputItemsToMessages(rawInput);

        // Tools: opaque JSON array, extract summaries only.
        const tools: ToolDefSummary[] = (Array.isArray(body.tools) ? body.tools : []).flatMap(
          (t) => {
            const rec = asRecord(t);
            if (!rec) return [];
            // Handle namespace tool (responses_lite collapses functions into one namespace).
            const name =
              asString(rec.name) ?? asString(asRecord(rec.function)?.name) ?? '(unnamed)';
            const description =
              asString(rec.description) ??
              asString(asRecord(rec.function)?.description) ??
              '';
            const schema = rec.parameters ?? asRecord(rec.function)?.parameters ?? null;
            return [
              {
                name,
                descriptionBytes: Buffer.byteLength(description, 'utf-8'),
                inputSchemaBytes: Buffer.byteLength(safeStringify(schema ?? null), 'utf-8'),
              },
            ];
          },
        );

        // Identity — authoritative session identity lives in the body, not the header.
        // FINDINGS §1.4 / §2.2: `session-id` header is the prompt-cache key.
        const clientMeta = asRecord(body.client_metadata) ?? {};
        const sessionId = asString(clientMeta.session_id);
        const threadId = asString(clientMeta.thread_id);
        const turnId = asString(clientMeta.turn_id);
        const parentTurnId = asString(clientMeta.parent_turn_id);

        // Params blob: everything except the large payload fields.
        const params: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) {
          if (!['input', 'instructions', 'tools'].includes(k)) params[k] = v;
        }

        // Injection tags: scan input items and headers.
        const injections = detectInjections(rawInput, headers);

        return {
          model,
          stream,
          system,
          messages,
          tools,
          paramsJson: safeStringify(params),
          rawRequestJson: ctx.body === undefined ? 'null' : safeStringify(ctx.body),
          // The authoritative session id from the body, not the header.
          clientSessionId: sessionId,
          harnessIdentity: {
            sessionId: sessionId ?? null,
            threadId: threadId ?? null,
            turnId: turnId ?? null,
            parentTurnId: parentTurnId ?? null,
          },
          // service_tier ∈ {priority, flex}. Sentinel "default" is filtered out
          // by Codex before sending and should never appear here.
          routingTier: asString(body.service_tier) ?? null,
          injections,
        };
      } catch {
        // Hard requirement from Adapter contract: normalizeRequest must never throw.
        return {
          model: null,
          stream: false,
          system: [],
          messages: [],
          tools: [],
          paramsJson: 'null',
          rawRequestJson: ctx.body === undefined ? 'null' : safeStringify(ctx.body),
          clientSessionId: null,
        };
      }
    },

    createObserver(): StreamObserver {
      return new CodexResponsesObserver(opts);
    },
  };
}
