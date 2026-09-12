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
 * Gemini, Vertex door (door B) — Door SAGA proxies as a plain passthrough to
 * the provider. The deployed URL is:
 *
 *   POST https://aiplatform.googleapis.com/v1beta1/publishers/google/models/{model}:streamGenerateContent?alt=sse
 *   x-goog-api-key: <Agent Platform key>
 *
 * Wire facts: FINDINGS-gemini.md §1.10 (authoritative, verified against SDK 1.30.0).
 * Spec:       docs/ws-c/C1-gemini-adapter.md
 *
 * Key differences from Anthropic/OpenAI:
 * - Model id lives in the URL, not the body.
 * - Tool results are `functionResponse` parts INSIDE a Content item (role:"user"),
 *   NOT top-level items.  Getting this wrong makes every tool round-trip look like
 *   a user message.
 * - NO terminal sentinel event.  Anthropic has `message_stop`, Gemini does not.
 *   HTTP stream ending IS the completion signal.  `finalize(reason)` is the only
 *   place to detect clean vs truncated.
 * - Six usage counters in `usageMetadata`, all lossless on this door.
 *   `toolUsePromptTokenCount` has no slot in the shared UsageSchema — kept in
 *   rawParams.
 */

// ---------------------------------------------------------------------------
// Header helpers — headers are case-insensitive in HTTP, so normalise on read.
// ---------------------------------------------------------------------------

function getHeader(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Part → ContentBlock conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Gemini `parts[]` array to normalised ContentBlocks.
 *
 * Part shapes (Gemini wire):
 *   text part:             { text: string, thought?: true, thoughtSignature?: string }
 *   function call:         { functionCall: { name, args } }
 *   function response:     { functionResponse: { name, response } }   ← tool result
 *   inline data (image):   { inlineData: { mimeType, data } }
 */
function geminiPartsToBlocks(parts: unknown[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    const rec = asRecord(part);
    if (!rec) {
      blocks.push(unknownBlock(part, typeof part));
      continue;
    }

    if (rec.thought === true && rec.text !== undefined) {
      // Thought part — `thought: true` distinguishes it from normal text.
      blocks.push({
        type: 'thinking',
        thinking: asString(rec.text) ?? '',
        signature: asString(rec.thoughtSignature) ?? null,
      });
    } else if (rec.text !== undefined) {
      blocks.push({ type: 'text', text: asString(rec.text) ?? '' });
    } else if (rec.functionCall !== undefined) {
      const fc = asRecord(rec.functionCall);
      // Gemini uses the function name as the stable id for matching call/response pairs.
      const name = asString(fc?.name) ?? '';
      const args = fc?.args ?? null;
      blocks.push({
        type: 'tool_use',
        id: name,
        name,
        input: args,
        inputJson: args !== null ? safeStringify(args) : null,
      });
    } else if (rec.functionResponse !== undefined) {
      // THE SHAPE TRAP: tool results are parts inside role:"user" Content, not
      // separate top-level items.  This is what makes them tool turns, not user turns.
      const fr = asRecord(rec.functionResponse);
      const name = asString(fr?.name) ?? '';
      const resp = fr?.response;
      blocks.push({
        type: 'tool_result',
        toolUseId: name,
        isError: false,
        content:
          resp !== undefined
            ? [{ type: 'text', text: safeStringify(resp) } as Extract<ContentBlock, { type: 'text' }>]
            : [],
      });
    } else if (rec.inlineData !== undefined) {
      const inlineData = asRecord(rec.inlineData);
      const data = asString(inlineData?.data);
      blocks.push({
        type: 'image',
        mediaType: asString(inlineData?.mimeType),
        byteSize: data ? Math.floor((data.length * 3) / 4) : null,
        note: 'content-not-stored',
      });
    } else {
      blocks.push(unknownBlock(rec, 'gemini-part'));
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Request normalisation
// ---------------------------------------------------------------------------

function normalizeRequest(ctx: AdapterRequestContext): NormalizedRequest {
  const body = asRecord(ctx.body) ?? {};

  // Model comes from the URL path, not the body.
  // Path segment: …/publishers/google/models/{model}:streamGenerateContent
  const path = ctx.path.split('?')[0] ?? '';
  const modelMatch = path.match(/\/publishers\/google\/models\/([^/:]+):/);
  const model = modelMatch?.[1] ?? null;

  // streamGenerateContent is always streaming; generateContent is not.
  const stream = /stream/i.test(path);

  // ---- System instruction ------------------------------------------------
  const system: NormalizedMessage[] = [];
  const sysInstr = asRecord(body.systemInstruction);
  if (sysInstr) {
    const sysParts = Array.isArray(sysInstr.parts) ? sysInstr.parts : [];
    const sysBlocks = geminiPartsToBlocks(sysParts);
    if (sysBlocks.length > 0) {
      system.push({
        role: 'system',
        blocks: sysBlocks,
        contextSource: 'system',
        contextSourceInferred: false,
      });
    }
  }

  // ---- Contents → messages -----------------------------------------------
  const rawContents = Array.isArray(body.contents) ? body.contents : [];
  const messages: NormalizedMessage[] = [];

  for (let i = 0; i < rawContents.length; i++) {
    const content = asRecord(rawContents[i]);
    if (!content) continue;

    const geminiRole = asString(content.role) ?? 'user';
    const parts: unknown[] = Array.isArray(content.parts) ? content.parts : [];

    // role:"model" → assistant; everything else → user
    const normalizedRole: NormalizedMessage['role'] = geminiRole === 'model' ? 'assistant' : 'user';

    const blocks = geminiPartsToBlocks(parts);

    // A Content item is tool-only when ALL its blocks are tool results.
    // This correctly handles the shape trap: role:"user" + functionResponse parts
    // is a tool-result turn, not a human turn.
    const toolOnly = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');

    messages.push({
      role: normalizedRole,
      blocks,
      contextSource: structuralContextSource(i, rawContents.length, normalizedRole, toolOnly),
      contextSourceInferred: false,
    });
  }

  // ---- Tools -------------------------------------------------------------
  // Gemini: tools[] entries carry functionDeclarations[], not flat defs.
  const tools: ToolDefSummary[] = [];
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  for (const t of rawTools) {
    const rec = asRecord(t);
    if (!rec) continue;
    const funcDecls = Array.isArray(rec.functionDeclarations) ? rec.functionDeclarations : [];
    for (const fd of funcDecls) {
      const fRec = asRecord(fd);
      if (!fRec) continue;
      tools.push({
        name: asString(fRec.name) ?? '(unnamed)',
        descriptionBytes: Buffer.byteLength(asString(fRec.description) ?? '', 'utf-8'),
        // Gemini calls the schema `parameters`, not `input_schema`.
        inputSchemaBytes: Buffer.byteLength(safeStringify(fRec.parameters ?? null), 'utf-8'),
      });
    }
  }

  // ---- Headers -----------------------------------------------------------
  // Routing tier: X-Vertex-AI-LLM-Request-Type ∈ {dedicated, shared}
  // combined with X-Vertex-AI-LLM-Shared-Request-Type ∈ {priority, flex}
  const requestType = getHeader(ctx.headers, 'x-vertex-ai-llm-request-type');
  const sharedType = getHeader(ctx.headers, 'x-vertex-ai-llm-shared-request-type');
  const routingTier: string | null =
    requestType && sharedType
      ? `${requestType}/${sharedType}`
      : requestType ?? sharedType ?? null;

  // syntheticSessionKey: install-scoped machine id; NOT a session id.
  // Return it so the capture layer can use it as a coarse partition key.
  const syntheticSessionKey =
    getHeader(ctx.headers, 'x-gemini-api-privileged-user-id') ?? null;

  // ---- Injection detection -----------------------------------------------
  // Tags SAGA can observe on the front door, before any gateway.
  // Source is saga-observed (NormalizedRequest.injections has no source field —
  // that field lives on the RequestStarted.injections after the capture layer
  // promotes these).
  const injections: Array<{ type: string; location: string | null; detail: string | null }> = [];

  // session_context is always the FIRST content item (index 0, role:user),
  // identified by the <session_context> marker.  Position-stable: INITIAL_HISTORY_LENGTH=1.
  const firstContent = asRecord(rawContents[0]);
  if (firstContent && asString(firstContent.role) !== 'model') {
    const firstParts: unknown[] = Array.isArray(firstContent.parts) ? firstContent.parts : [];
    const firstText = firstParts
      .map((p) => asString(asRecord(p)?.text) ?? '')
      .join('');
    if (firstText.includes('<session_context>')) {
      injections.push({ type: 'session_context', location: 'contents[0]', detail: null });
      // folder_tree is gated on getIncludeDirectoryTree(); its marker nests inside session_context.
      if (firstText.includes('<session_context:folder_tree>')) {
        injections.push({
          type: 'session_context:folder_tree',
          location: 'contents[0]',
          detail: null,
        });
      }
    }
    // history_hardening: rewritten/repaired history before send (historyHardening.ts:202).
    if (firstText.includes('<history_hardening>')) {
      injections.push({ type: 'history_hardening', location: 'contents[0]', detail: null });
    }
  }

  // vertex_routing_tier: present when routing is configured on this door.
  if (routingTier) {
    injections.push({
      type: 'vertex_routing_tier',
      location: 'header:x-vertex-ai-llm-request-type',
      detail: routingTier,
    });
  }

  // ---- Params JSON -------------------------------------------------------
  // Capture generationConfig, safetySettings, cachedContent, labels etc.
  // Exclude the large structured fields already normalised above.
  const excluded = new Set(['contents', 'systemInstruction', 'tools', 'toolConfig']);
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!excluded.has(k)) params[k] = v;
  }

  return {
    model,
    stream,
    system,
    messages,
    tools,
    paramsJson: safeStringify(params),
    rawRequestJson: ctx.body === undefined ? 'null' : safeStringify(ctx.body),
    // clientSessionId: Vertex door declares nothing session-scoped.
    clientSessionId: null,
    // harnessIdentity: Gemini-Vertex declares no harness identity fields.
    harnessIdentity: null,
    routingTier,
    injections,
    syntheticSessionKey,
  };
}

// ---------------------------------------------------------------------------
// Stream observer
// ---------------------------------------------------------------------------

/**
 * Key design constraint: Gemini has NO terminal sentinel event.
 * Anthropic has `message_stop`, OpenAI has `[DONE]`, Codex has
 * `response.completed`.  For Gemini, stream ending IS completion.
 *
 * Consequence: do NOT set a `complete` flag off a frame — there is no frame
 * to set it from.  The `reason` parameter passed to `finalize()` by the
 * capture layer is the ONLY completion signal.  `reason === 'complete'` means
 * the HTTP stream ended cleanly; anything else is truncation or error.
 *
 * Usage comes from `usageMetadata` on the LAST frame (cumulative, updated
 * each chunk).  All six counters survive on this door.
 * `toolUsePromptTokenCount` has no slot in UsageSchema — kept in rawParams by
 * the normaliseRequest path (included in paramsJson via generationConfig).
 */
class GeminiObserver implements StreamObserver {
  private readonly usageSource: AdapterOptions['usageSource'];

  // usageMetadata: last seen wins (the wire sends cumulative values).
  private promptTokenCount: number | undefined = undefined;
  private candidatesTokenCount: number | undefined = undefined;
  private totalTokenCount: number | undefined = undefined;
  private cachedContentTokenCount: number | undefined = undefined;
  private thoughtsTokenCount: number | undefined = undefined;
  // Kept for completeness; not surfaced in UsageSchema.
  private toolUsePromptTokenCount: number | undefined = undefined;

  private stopReason: string | null = null;
  private sawContent = false;

  // Response content accumulators.
  private textAcc = '';
  private thinkingAcc = '';
  private thinkingSignature: string | null = null;
  // Tool uses keyed by function name (Gemini uses name as stable id).
  private toolUsesMap = new Map<string, { name: string; args: unknown }>();

  private frames = 0;
  private bytes = 0;
  private parseErrors = 0;

  constructor(opts: AdapterOptions) {
    this.usageSource = opts.usageSource;
  }

  private uv(v: number | undefined): UsageValue | null {
    return v !== undefined && Number.isFinite(v) && v >= 0
      ? { value: Math.floor(v), source: this.usageSource }
      : null;
  }

  onFrame(frame: SseFrame): void {
    this.frames++;
    this.bytes += frame.data.length;

    const j = asRecord(frame.json);
    if (!j) {
      // Blank lines and non-JSON data are normal in SSE; count only genuine
      // parse errors (non-blank, non-parseable data).
      if (frame.data.trim() !== '') this.parseErrors++;
      return;
    }

    // usageMetadata — overwrite on every frame; the last one is cumulative.
    const um = asRecord(j.usageMetadata);
    if (um) {
      if (typeof um.promptTokenCount === 'number')
        this.promptTokenCount = um.promptTokenCount;
      if (typeof um.candidatesTokenCount === 'number')
        this.candidatesTokenCount = um.candidatesTokenCount;
      if (typeof um.totalTokenCount === 'number')
        this.totalTokenCount = um.totalTokenCount;
      if (typeof um.cachedContentTokenCount === 'number')
        this.cachedContentTokenCount = um.cachedContentTokenCount;
      if (typeof um.thoughtsTokenCount === 'number')
        this.thoughtsTokenCount = um.thoughtsTokenCount;
      if (typeof um.toolUsePromptTokenCount === 'number')
        this.toolUsePromptTokenCount = um.toolUsePromptTokenCount;
    }

    // candidates[0] carries the streamed content and finishReason.
    const candidates = Array.isArray(j.candidates) ? j.candidates : [];
    for (const candidate of candidates) {
      const cRec = asRecord(candidate);
      if (!cRec) continue;

      const fr = asString(cRec.finishReason);
      // FINISH_REASON_UNSPECIFIED means the stream is still going; skip it.
      if (fr && fr !== 'FINISH_REASON_UNSPECIFIED' && fr !== '0') {
        this.stopReason = fr;
      }

      const content = asRecord(cRec.content);
      if (!content) continue;
      const parts: unknown[] = Array.isArray(content.parts) ? content.parts : [];

      for (const part of parts) {
        const pRec = asRecord(part);
        if (!pRec) continue;

        if (pRec.thought === true && pRec.text !== undefined) {
          this.thinkingAcc += asString(pRec.text) ?? '';
          if (pRec.thoughtSignature !== undefined) {
            this.thinkingSignature =
              (this.thinkingSignature ?? '') + (asString(pRec.thoughtSignature) ?? '');
          }
          this.sawContent = true;
        } else if (pRec.text !== undefined) {
          this.textAcc += asString(pRec.text) ?? '';
          this.sawContent = true;
        } else if (pRec.functionCall !== undefined) {
          const fc = asRecord(pRec.functionCall);
          if (fc) {
            const name = asString(fc.name) ?? '';
            this.toolUsesMap.set(name, { name, args: fc.args ?? null });
            this.sawContent = true;
          }
        }
      }
    }
  }

  onCompleteBody(body: unknown): void {
    // Non-streaming path: treat the complete response body as one frame.
    const j = asRecord(body);
    if (!j) {
      this.frames++;
      return;
    }
    // Build a synthetic SseFrame so we reuse the same parsing logic.
    const syntheticFrame: SseFrame = {
      event: null,
      data: safeStringify(body),
      json: body,
    };
    this.onFrame(syntheticFrame);
  }

  sawFirstContent(): boolean {
    return this.sawContent;
  }

  outputTokensSoFar(): UsageValue | null {
    return this.uv(this.candidatesTokenCount);
  }

  /**
   * Called by the capture layer when the HTTP stream ends.
   *
   * For Gemini, `reason === 'complete'` IS the clean-stream signal — there is
   * no sentinel frame to distinguish it from a truncated stream, so the capture
   * layer's HTTP-level signal is authoritative.
   *
   * Clean stream:  reason='complete' → trust wire stopReason (e.g. "STOP"),
   *                or leave it null if the wire didn't report one.
   * Truncated:     reason='client_aborted' → mark stopReason as 'client_aborted'.
   * Upstream error: reason='upstream_error' → leave stopReason null (error channel
   *                carries the detail).
   */
  finalize(reason: 'complete' | 'client_aborted' | 'upstream_error'): ObserverResult {
    const usage: Usage = {
      input: this.uv(this.promptTokenCount),
      output: this.uv(this.candidatesTokenCount),
      cacheRead: this.uv(this.cachedContentTokenCount),
      cacheWrite: null, // Vertex doesn't report cache writes on this door.
      thought: this.uv(this.thoughtsTokenCount),
      total: this.uv(this.totalTokenCount),
      // credits: always null — Vertex bills GCP-side, nothing on the wire (V23).
    };

    // Assemble response blocks in order: thought → text → tool_use.
    const blocks: ContentBlock[] = [];
    if (this.thinkingAcc) {
      blocks.push({
        type: 'thinking',
        thinking: this.thinkingAcc,
        signature: this.thinkingSignature,
      });
    }
    if (this.textAcc) {
      blocks.push({ type: 'text', text: this.textAcc });
    }

    const toolUses: ObserverResult['toolUses'] = [];
    let blockIndex = blocks.length;
    for (const [, tu] of this.toolUsesMap) {
      const inputJson = tu.args !== null ? safeStringify(tu.args) : null;
      blocks.push({
        type: 'tool_use',
        id: tu.name,
        name: tu.name,
        input: tu.args,
        inputJson,
      });
      toolUses.push({
        blockIndex,
        toolUseId: tu.name,
        name: tu.name,
        inputJson,
      });
      blockIndex++;
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

    // Determine effective stop reason.
    // Wire finishReason takes priority (e.g. "STOP", "MAX_TOKENS").
    // client_aborted overrides when we had no wire reason and the client cut the stream.
    let effectiveStopReason = this.stopReason;
    if (effectiveStopReason == null && reason === 'client_aborted') {
      effectiveStopReason = 'client_aborted';
    }

    return {
      usage,
      stopReason: effectiveStopReason,
      message,
      toolUses,
      frameStats: { frames: this.frames, bytes: this.bytes, parseErrors: this.parseErrors },
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function geminiAdapter(opts: AdapterOptions): Adapter {
  return {
    id: 'gemini',
    provider: 'google-vertex',
    displayName: 'Gemini (Vertex)',

    /**
     * Match the colon-method Vertex path + x-goog-api-key or Gemini User-Agent.
     *
     * Target URL:
     *   …/v1beta1/publishers/google/models/{model}:streamGenerateContent?alt=sse
     *
     * The colon-method means `{model}:streamGenerateContent` is ONE path segment —
     * a naive `endsWith` on a fixed string will match door-A paths too, so we
     * test for `publishers/google/models/` + a model segment + `:GenerateContent`
     * (covers both stream and unary).
     *
     * Strongest client signal: User-Agent `GeminiCLI/{version}/{model}` or
     * the substring `proxy_client=geminicli` (VS Code variant).
     *
     * Secondary: `x-goog-api-key` header (Vertex Express key).
     */
    matches(ctx: AdapterRequestContext): boolean {
      const path = ctx.path.split('?')[0] ?? '';

      // Path must contain the Vertex publishers/google/models colon-method form.
      // Matches both :streamGenerateContent and :generateContent; excludes door-A
      // v1internal and the generativelanguage.googleapis.com AI-Studio path.
      const isVertexPath = /\/publishers\/google\/models\/[^/:]+:(?:stream)?generateContent/i.test(path);
      if (!isVertexPath) return false;

      // At least one of: API key header OR Gemini User-Agent.
      const hasApiKey = getHeader(ctx.headers, 'x-goog-api-key') !== null;
      const ua = getHeader(ctx.headers, 'user-agent') ?? '';
      const hasGeminiUA = ua.includes('GeminiCLI/') || ua.includes('proxy_client=geminicli');

      return hasApiKey || hasGeminiUA;
    },

    normalizeRequest,

    createObserver(): StreamObserver {
      return new GeminiObserver(opts);
    },
  };
}
