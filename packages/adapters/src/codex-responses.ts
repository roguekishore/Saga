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
 * Codex `/v1/responses` (door A) — STUB. Implemented by C2.
 * Spec: `docs/ws-c/C2-codex-adapter.md`. Wire detail:
 * `D:/PROJECTS/AI/analysis/FINDINGS-codex.md` (authoritative).
 *
 * NOT the existing `openai.ts` adapter: that one speaks `/v1/chat/completions`,
 * a different endpoint with a different body shape. Do not edit it and do not
 * generalize it to cover both.
 *
 * Codex is the BEST case of the three harnesses — it declares session, thread,
 * turn, and `call_role` on the wire — so this adapter is mostly transcription.
 * The risk is not difficulty; it is reading the wrong field and silently
 * mis-grouping everything.
 *
 * ===========================================================================
 * TODO(C2). `matches()` returns FALSE until then, so Codex traffic falls through
 * to `passthrough` and is recorded opaquely rather than being claimed as
 * understood-but-empty. See the equivalent note in `gemini.ts`.
 * ===========================================================================
 */

class CodexResponsesObserver implements StreamObserver {
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
   * C2: Codex DOES have a terminal sentinel — `response.completed`. Set your
   * completion flag off it, as the Anthropic and OpenAI observers do off theirs.
   * (Contrast `gemini.ts`, which has none and must synthesize end-of-turn.)
   *
   * Provenance here is `gateway-computed`: the upstream is CONDUIT, not OpenAI.
   * Take `usageSource` from `AdapterOptions` rather than hard-coding, and never
   * report `upstream-reported` on door A. The real figures arrive later over the
   * ingest seam, and the writer resolves the two by provenance rank — so an
   * honest gateway-computed number here is correct and cannot clobber the real
   * one whichever lands first.
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

export function codexResponsesAdapter(): Adapter {
  return {
    id: 'codex-responses',
    provider: 'openai-responses',
    displayName: 'Codex Responses',

    /**
     * C2: match `POST …/responses`. `originator: codex_cli_rs` corroborates but
     * is only sent when non-default, so **absence is not evidence of not-Codex**
     * — a `matches()` that requires it drops real traffic to passthrough. Reject
     * `/v1/chat/completions` and `/v1/messages`.
     */
    matches(_ctx: AdapterRequestContext): boolean {
      return false; // TODO(C2)
    },

    /**
     * C2: the Responses shape uses `input[]` items and `instructions`, not
     * `messages[]`. Item types to handle: `message`, `function_call`,
     * `function_call_output` (a TOP-LEVEL item, unlike Gemini's nesting), and
     * `reasoning` (may carry `encrypted_content` → map to `redacted_thinking`,
     * which exists precisely for reasoning SAGA cannot read). Map onto the
     * existing block vocabulary rather than inventing block types.
     *
     * ⚠️ THE TRAP — session id is in the BODY, not the header. The `session-id`
     * HEADER is the prompt-cache key, not the session (confirmed against a source
     * comment in Codex itself). Keying on it will group unrelated conversations
     * and split real ones, and it will look plausible while doing so. Read
     * `client_metadata.session_id` / `.thread_id` / `.turn_id` and
     * `parent_thread_id`/`parent_turn_id` from the body into `harnessIdentity`,
     * verbatim — downstream code treats them as ground truth, so do not
     * reformat or prefix them.
     *
     * Also surface `service_tier` ∈ {priority, flex} as `routingTier`, and the
     * observable injections in `injections`: `user_instructions`,
     * `environment_context`, **`environment_context:diff`** (a PARTIAL per-turn
     * block — surface it loudly; it means "what the model knew" is spread across
     * several requests), `responses_lite_prefix`, `reasoning_encrypted`,
     * `compaction`.
     */
    normalizeRequest(ctx: AdapterRequestContext): NormalizedRequest {
      const body = asRecord(ctx.body);
      return {
        model: asString(body?.model),
        stream: body?.stream === true,
        system: [],
        messages: [],
        tools: [],
        paramsJson: 'null',
        rawRequestJson: ctx.body === undefined ? 'null' : safeStringify(ctx.body),
        clientSessionId: null,
      };
    },

    createObserver(): StreamObserver {
      return new CodexResponsesObserver();
    },
  };
}
