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
 * Fallback adapter — matches anything, normalizes nothing. Registered last.
 * This is what keeps SAGA gateway-agnostic on routes it has never seen:
 * traffic is proxied untouched and recorded as an opaque request (redacted
 * raw JSON only, byte/frame counts, no invented structure).
 */

class PassthroughObserver implements StreamObserver {
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

export function passthroughAdapter(): Adapter {
  return {
    id: 'passthrough',
    provider: 'unknown',
    displayName: 'Passthrough',
    matches(): boolean {
      return true;
    },
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
        // An unrecognized route: inventing a session id from it would be a
        // guess dressed as wire evidence.
        clientSessionId: null,
      };
    },
    createObserver(): StreamObserver {
      return new PassthroughObserver();
    },
  };
}
