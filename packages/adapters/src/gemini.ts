import type {
  Adapter,
  AdapterRequestContext,
  NormalizedRequest,
  ObserverResult,
  SseFrame,
  StreamObserver,
} from '@saga/contracts';
import { asRecord, asString, safeStringify } from './shared';

/**
 * Gemini, Vertex door (door B) — STUB. Implemented by C1.
 * Spec: `docs/ws-c/C1-gemini-adapter.md`. Wire detail:
 * `D:/PROJECTS/AI/analysis/FINDINGS-gemini.md` (authoritative).
 *
 * The deployment is FIXED: Vertex / Agent Platform key, door B only. Ignore
 * anything about a door-A path, CodeAssist, or `v1internal` — it does not occur
 * here. The door SAGA proxies is a plain documented public API:
 *
 *   POST https://aiplatform.googleapis.com/v1beta1/publishers/google/models/{model}:streamGenerateContent?alt=sse
 *   x-goog-api-key: <Agent Platform key>
 *
 * Why this matters more than the other adapters: Gemini is the HARD case for
 * identity (declares no session, no turn boundary) and the BEST case for
 * metrics (six counters, lossless, straight off the wire — no seam, no gateway
 * estimate in the middle). It is also the only feed that can never have a credit
 * figure: Vertex bills GCP-side and nothing appears on the wire.
 *
 * ===========================================================================
 * TODO(C1). `matches()` returns FALSE until then, deliberately: unmatched door-B
 * traffic falls through to `passthrough`, which records it opaquely — redacted
 * raw JSON, byte and frame counts, no invented structure. That is the honest
 * degraded state. An adapter that matched but normalized nothing would instead
 * assert "we understood this request" and silently produce empty structure.
 * ===========================================================================
 */

class GeminiObserver implements StreamObserver {
  private frames = 0;
  private bytes = 0;

  onFrame(frame: SseFrame): void {
    this.frames++;
    this.bytes += frame.data.length;
  }
  onCompleteBody(_body: unknown): void {
    this.frames++;
  }
  sawFirstContent(): boolean {
    return false;
  }
  outputTokensSoFar(): null {
    return null;
  }

  /**
   * C1: the critical difference from every other observer in this repo is that
   * Gemini sends **NO terminal sentinel**. Anthropic has `message_stop`, OpenAI
   * `[DONE]`, Codex `response.completed`; here completion IS the HTTP stream
   * ending, so `finalize()` is your only completion signal. Do not wait for a
   * frame that will never arrive, and make sure a clean stream is still
   * distinguishable from a truncated one — the sibling observers set a `complete`
   * flag off their sentinel and you have none to set it from.
   *
   * Read `usageMetadata` WHOLE: promptTokenCount → input, candidatesTokenCount →
   * output, totalTokenCount → total, cachedContentTokenCount → cacheRead,
   * thoughtsTokenCount → thought. `toolUsePromptTokenCount` has no slot by
   * design — keep it in raw params rather than forcing a seventh counter into a
   * shared contract.
   */
  finalize(): ObserverResult {
    return {
      usage: { input: null, output: null, cacheRead: null, cacheWrite: null },
      stopReason: null,
      message: null,
      toolUses: [],
      frameStats: { frames: this.frames, bytes: this.bytes, parseErrors: 0 },
    };
  }
}

export function geminiAdapter(): Adapter {
  return {
    id: 'gemini',
    provider: 'google-vertex',
    displayName: 'Gemini (Vertex)',

    /**
     * C1: match the colon-method Vertex path plus `x-goog-api-key`. Note the
     * model id shares a path segment with the method
     * (`…/models/{model}:streamGenerateContent`), so a fixed `endsWith` will not
     * do it — parse the segment, and lift the model from there because this API
     * puts it in the URL rather than the body.
     *
     * Strongest client signal is the User-Agent `GeminiCLI/{version}/{model}`,
     * or `proxy_client=geminicli` for the VS Code form. Be careful not to match
     * door-A traffic.
     */
    matches(_ctx: AdapterRequestContext): boolean {
      return false; // TODO(C1)
    },

    /**
     * C1: body is `{contents[], systemInstruction, tools[{functionDeclarations}],
     * generationConfig{thinkingConfig{…}}}`.
     *
     * THE SHAPE TRAP: tool results are `functionResponse` parts nested INSIDE a
     * `Content`, not top-level items as in the Anthropic and OpenAI shapes. Get
     * this wrong and every tool round-trip normalizes as an ordinary user
     * message, which breaks C3's turn grouping downstream.
     *
     * Return `clientSessionId: null` — the Vertex door declares nothing
     * session-scoped. Put the install-scoped `x-gemini-api-privileged-user-id`
     * in `syntheticSessionKey` instead, which is where the capture layer expects
     * a partition it may synthesize a session from. It is a MACHINE id, not a
     * session; the redact layer fingerprints it for that reason.
     *
     * Surface `routingTier` from `X-Vertex-AI-LLM-Request-Type` /
     * `-Shared-Request-Type`, and the observable injections
     * (`session_context`, `session_context:folder_tree`, `history_hardening`,
     * `vertex_routing_tier`) in `injections`. The door-A tags
     * (`thought_rewritten`, `credits_consumed`) do NOT fire here.
     */
    normalizeRequest(ctx: AdapterRequestContext): NormalizedRequest {
      const body = asRecord(ctx.body);
      return {
        model: asString(body?.model),
        stream: false,
        system: [],
        messages: [],
        tools: [],
        paramsJson: 'null',
        rawRequestJson: ctx.body === undefined ? 'null' : safeStringify(ctx.body),
        clientSessionId: null,
      };
    },

    createObserver(): StreamObserver {
      return new GeminiObserver();
    },
  };
}
