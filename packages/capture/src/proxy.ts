import type {
  Adapter,
  Door,
  Logger,
  NormalizedEvent,
  NormalizedRequest,
  RequestStatus,
  StreamObserver,
} from '@saga/contracts';
import { noopLogger } from '@saga/contracts';
import { redactMessage, redactNormalizedRequest, scrubHeaders, scrubText } from '@saga/redact';
import { AgentCorrelator } from './agents';
import { classifyCallRole } from './call-role';
import {
  detectHarness,
  extractClientName,
  extractWorkspace,
  SessionCorrelator,
  systemFingerprint,
} from './session';
import { SseParser } from './sse';
import { classifyTurn, TurnCorrelator } from './turns';
import { ulid } from './ulid';

/**
 * The reverse proxy. Two invariants outrank everything here:
 *
 * 1. NEVER block the response. The upstream body is tee()'d; the client's
 *    branch is returned before the capture branch is read. Ground truth
 *    (2026-09-01): the client finishes even when the capture consumer stalls.
 * 2. Capture failures NEVER propagate. Every capture path is wrapped; a
 *    failing SAGA passes traffic through and says so on its own channels.
 *
 * Everything emitted downstream is redacted HERE, before the queue — the
 * store, the WebSocket, and the UI only ever see scrubbed payloads.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyOptions {
  /** Explicit loopback by default. The upstream binding 0.0.0.0 is a bug, not a pattern. */
  host?: string;
  port: number;
  upstream: string;
  /**
   * Which front door this instance is. SAGA runs TWO instances feeding one
   * store: door A upstream to CONDUIT (Claude Code + Codex), door B upstream to
   * Google (Gemini, plain passthrough).
   *
   * Deliberately one upstream per instance rather than a per-request router:
   * routing inside `handle` would put provider branching in the hot path, which
   * the architecture forbids. Two instances keep both invariants untouched and
   * cost only a second `Bun.serve`.
   *
   * Defaults to 'A' so existing single-door callers and tests are unaffected.
   */
  door?: Door;
  adapters: Adapter[];
  emit: (ev: NormalizedEvent) => void;
  logger?: Logger;
  /** Throttle for token_stream ticks. */
  tokenTickMs?: number;
  /** Cap on buffered non-SSE bodies for capture (forwarding is unaffected). */
  captureMaxBodyBytes?: number;
}

export interface ProxyHandle {
  port: number;
  host: string;
  upstream: string;
  activeRequests(): number;
  stop(): void;
  fetchHandler(req: Request): Promise<Response>;
}

interface CaptureCtx {
  requestId: string;
  t0: number;
  ts0: number;
  observer: StreamObserver | null;
  adapter: Adapter;
  startedEmitted: boolean;
  firstTokenEmitted: boolean;
  ttftMs: number | null;
  errorFromObserver: { type: string; message: string } | null;
  clientSignal: AbortSignal;
  sessionId: string | null;
  emittedToolBlocks: Set<number>;
}

export function startProxy(opts: ProxyOptions): ProxyHandle {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.logger ?? noopLogger;
  const tokenTickMs = opts.tokenTickMs ?? 100;
  const captureMax = opts.captureMaxBodyBytes ?? 20 * 1024 * 1024;
  const correlator = new SessionCorrelator(() => ulid());
  const agentCorrelator = new AgentCorrelator(() => ulid());
  const turnCorrelator = new TurnCorrelator(() => ulid());
  const door: Door = opts.door ?? 'A';
  /**
   * Models seen per session, for the Sonnet-under-Opus subagent signal (Claude
   * Code drops subagents to Sonnet by default). Bounded like the correlators'
   * maps — one entry per session, never revisited once a conversation ends.
   */
  const sessionModels = new Map<string, string[]>();
  let active = 0;

  const emitSafe = (ev: NormalizedEvent): void => {
    try {
      opts.emit(ev);
    } catch (err) {
      log.log('error', 'proxy', `emit failed: ${String(err)}`);
    }
  };

  const captureError = (requestId: string, where: string, err: unknown): void => {
    emitSafe({
      kind: 'capture_error',
      requestId,
      ts: Date.now(),
      where,
      message: scrubText(String(err)).value.slice(0, 500),
    });
  };

  /**
   * Run one classifier, and on a throw fall back to the stated-unknown value.
   *
   * Per-classifier rather than relying on the enclosing request-capture catch:
   * that catch abandons the whole `request_started` emit, so one bad heuristic
   * would cost the entire request row instead of a single label. A classifier
   * failure is visible as a `capture_error` and the request is still recorded,
   * honestly labeled as unknown.
   */
  const safeClassify = <T>(requestId: string, where: string, fallback: T, fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      captureError(requestId, where, err);
      return fallback;
    }
  };

  async function handle(req: Request): Promise<Response> {
    const t0 = performance.now();
    const ts0 = Date.now();
    const requestId = `req_${ulid(ts0)}`;
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    active++;

    // ---- read the client's body (its own send time, not added latency)
    let bodyBytes: ArrayBuffer | null = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      bodyBytes = await req.arrayBuffer();
    }

    // ---- forward FIRST; normalization happens while upstream works
    const fwdHeaders = new Headers();
    req.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'accept-encoding') return;
      fwdHeaders.set(k, v);
    });
    // Identity keeps forwarded bytes byte-identical to what fetch yields —
    // no decompress/re-encode mismatch on the tee.
    fwdHeaders.set('accept-encoding', 'identity');
    // The correlation id, FORWARDED UPSTREAM. Previously this was set only on
    // the response back to the client, which left the CONDUIT seam inert: the
    // contract has CONDUIT echo `x-saga-request-id` back on its emit so SAGA can
    // join metrics and rewritten-out to the clean-in it already stored, and
    // CONDUIT cannot echo an id it never receives. It stays on the response too,
    // since clients may already rely on reading it there.
    fwdHeaders.set('x-saga-request-id', requestId);

    // Aborting this fetch is only safe BEFORE the response body is tee()'d.
    // Ground truth (Bun 1.3.13, Windows x64): aborting the source of a live
    // tee makes Bun error both branch controllers from an internal closure;
    // if Bun.serve has already torn down the client branch's sink — exactly
    // what a client disconnect mid-stream does — that closure dereferences a
    // detached controller and throws `TypeError: null is not an object` as an
    // unhandled rejection, which kills the collector process. So after the
    // tee exists the client's abort is not forwarded: the capture branch runs
    // the upstream response to completion, which also means an abandoned
    // stream is still recorded in full. `teed` is only ever set on the
    // response path, before the client branch is handed to Bun.serve.
    const upstreamAbort = new AbortController();
    let teed = false;
    req.signal.addEventListener(
      'abort',
      () => {
        if (!teed) upstreamAbort.abort();
      },
      { once: true },
    );

    const upstreamPromise = fetch(opts.upstream + path, {
      method: req.method,
      headers: fwdHeaders,
      body: bodyBytes && bodyBytes.byteLength > 0 ? bodyBytes : undefined,
      redirect: 'manual',
      signal: upstreamAbort.signal,
    });
    // A pre-response upstream failure is handled at the await below; this
    // catch only silences the unhandled-rejection warning.
    upstreamPromise.catch(() => {});

    // ---- capture: request side (fully wrapped; forwarding owes it nothing)
    const ctx: CaptureCtx = {
      requestId,
      t0,
      ts0,
      observer: null,
      adapter: opts.adapters[opts.adapters.length - 1]!,
      startedEmitted: false,
      firstTokenEmitted: false,
      ttftMs: null,
      errorFromObserver: null,
      clientSignal: req.signal,
      sessionId: null,
      emittedToolBlocks: new Set(),
    };
    // Forwarded like anything else, but NOT recorded: a bodyless method cannot
    // carry a conversation. Measured on the live corpus: 7 `HEAD /api/hello`
    // reachability probes (User-Agent Bun/1.4.1, no model, no messages) each
    // minted a session of their own, so the session list grew a fresh empty
    // "conversation" every time a client checked whether the proxy was up.
    //
    // HEAD ONLY, and the narrowness is deliberate. A HEAD carries no request
    // body and, by definition, no response body either, so there is nothing a
    // conversation could be made of. Every hello probe observed was a HEAD.
    //
    // GET is NOT excluded, even though a GET is never a conversation either:
    // SAGA deliberately records catalog reads and error responses on routes it
    // has never seen (`GET /v1/models` via the passthrough adapter, `GET /fail`
    // as upstream_error), and packages/capture/test/proxy.test.ts pins both.
    // Dropping GETs would trade a real capability for a cosmetic win.
    //
    // Forwarding is untouched — this only decides whether a row is written.
    const capturable = req.method !== 'HEAD';
    if (!capturable) {
      log.log('debug', 'proxy', `not recorded (no conversation): ${req.method} ${path}`);
    }
    try {
      if (capturable) {
        const rawHeaders: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          rawHeaders[k.toLowerCase()] = v;
        });
        const redHeaders = scrubHeaders(rawHeaders).value;

        let parsedBody: unknown = null;
        if (bodyBytes && bodyBytes.byteLength > 0) {
          try {
            parsedBody = JSON.parse(new TextDecoder().decode(bodyBytes));
          } catch {
            parsedBody = null;
          }
        }
        const adapterCtx = { method: req.method, path, headers: redHeaders, body: parsedBody };
        ctx.adapter =
          opts.adapters.find((a) => {
            try {
              return a.matches(adapterCtx);
            } catch {
              return false;
            }
          }) ?? ctx.adapter;

        let normalized: NormalizedRequest;
        try {
          normalized = ctx.adapter.normalizeRequest(adapterCtx);
        } catch (err) {
          captureError(requestId, `normalize:${ctx.adapter.id}`, err);
          normalized = {
            model: null,
            stream: false,
            system: [],
            messages: [],
            tools: [],
            paramsJson: 'null',
            rawRequestJson: 'null',
          };
        }
        const red = redactNormalizedRequest(normalized);
        const clientName = extractClientName(redHeaders);
        const workspace = extractWorkspace(red.value);
        const fingerprint = systemFingerprint(red.value);
        // `clientSessionId` survives redaction by design: the adapter lifts it
        // off the original body into a typed field, so scrubbing the params
        // (which is what removes the sibling device fingerprint) cannot take the
        // session boundary with it.
        const session = correlator.assign({
          clientName,
          workspace,
          systemFingerprint: fingerprint,
          ts: ts0,
          clientSessionId: red.value.clientSessionId ?? null,
          // Gemini declares nothing session-scoped on the Vertex door, so SAGA
          // synthesizes a key from the install-scoped id the adapter surfaces.
          // Reported `inferred`, because an install is not a session.
          syntheticKey: red.value.syntheticSessionKey ?? null,
        });
        const sessionId = session.sessionId;
        ctx.sessionId = sessionId;

        const firstSystemText = red.value.system[0]?.blocks.find((b) => b.type === 'text');
        const agent = agentCorrelator.assign({
          sessionId,
          requestId,
          systemFingerprint: fingerprint,
          systemHead:
            firstSystemText && firstSystemText.type === 'text'
              ? firstSystemText.text.slice(0, 300)
              : '',
          ts: ts0,
        });

        // ---- hierarchy classification.
        //
        // Each classifier is wrapped INDIVIDUALLY, not just under the enclosing
        // request-capture try: a bug in a classifier must cost one label, not the
        // whole request record. The enclosing catch would swallow request_started
        // entirely, losing the row this request is meant to produce.
        const harness = safeClassify(requestId, 'detect-harness', 'unknown' as const, () =>
          detectHarness({ endpoint: url.pathname, clientName, headers: redHeaders, door }),
        );

        // callRole is classified FIRST because the turn boundary depends on it:
        // a `utility` call is one of the harness's own internal helpers and must
        // never open a turn. Ordered the other way, classifyTurn would receive
        // `undefined` and silently fall back to opening one.
        const models = sessionModels.get(sessionId) ?? [];
        const callRole = safeClassify(
          requestId,
          'classify-call-role',
          { role: 'unknown' as const, source: 'inferred' as const, evidence: [] },
          () =>
            classifyCallRole({
              request: red.value,
              headers: redHeaders,
              adapterId: ctx.adapter.id,
              door,
              sessionModels: models,
            }),
        );

        const turnClass = safeClassify(
          requestId,
          'classify-turn',
          {
            kind: 'unknown' as const,
            source: 'inferred' as const,
            harnessTurnId: null,
            evidence: [],
          },
          () =>
            classifyTurn({
              request: red.value,
              headers: redHeaders,
              adapterId: ctx.adapter.id,
              door,
              callRole: callRole.role,
            }),
        );
        const turnAssignment = safeClassify(requestId, 'assign-turn', null, () =>
          turnCorrelator.assign({ sessionId, classification: turnClass, ts: ts0 }),
        );
        // Recorded AFTER classification, so a request is never compared against
        // its own model when deciding "is this a cheaper model than the session's".
        if (red.value.model && !models.includes(red.value.model)) {
          models.push(red.value.model);
          sessionModels.set(sessionId, models);
          if (sessionModels.size > 500) {
            const oldest = sessionModels.keys().next().value;
            if (oldest) sessionModels.delete(oldest);
          }
        }

        ctx.observer = ctx.adapter.createObserver();
        emitSafe({
          kind: 'request_started',
          requestId,
          ts: ts0,
          sessionId,
          sessionIdSource: session.source,
          clientSessionId: session.clientSessionId,
          adapterId: ctx.adapter.id,
          provider: ctx.adapter.provider,
          endpoint: url.pathname,
          method: req.method,
          upstreamUrl: opts.upstream,
          clientName,
          workspace,
          model: red.value.model,
          stream: red.value.stream,
          request: red.value,
          redaction: { hits: red.hits, flagged: red.flagged },
          agent,
          door,
          harness,
          routingTier: red.value.routingTier ?? null,
          turn: turnAssignment
            ? {
                turnId: turnAssignment.turnId,
                seq: turnAssignment.seq,
                kind: turnClass.kind,
                source: turnClass.source,
                harnessTurnId: turnClass.harnessTurnId,
                opened: turnAssignment.opened,
                partial: turnAssignment.partial,
                evidence: turnClass.evidence,
              }
            : null,
          callRole,
          harnessIdentity: red.value.harnessIdentity ?? null,
          injections: (red.value.injections ?? []).map((inj) => ({
            type: inj.type,
            location: inj.location ?? null,
            source: 'saga-observed' as const,
            detail: inj.detail ?? null,
          })),
        });
        ctx.startedEmitted = true;
      }
    } catch (err) {
      captureError(requestId, 'request-capture', err);
    }

    // ---- upstream response
    let res: Response;
    try {
      res = await upstreamPromise;
    } catch (err) {
      active--;
      const aborted = req.signal.aborted;
      finishWithoutBody(ctx, aborted ? 'client_aborted' : 'upstream_error', null, {
        type: aborted ? 'client_aborted' : 'upstream_unreachable',
        message: scrubText(String(err)).value.slice(0, 300),
      });
      return Response.json(
        {
          error: {
            type: 'saga_upstream_unreachable',
            message: `SAGA could not reach upstream ${opts.upstream}`,
          },
        },
        { status: 502 },
      );
    }

    const respHeaders = new Headers();
    res.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower)) return;
      if (lower === 'content-encoding' || lower === 'content-length') return;
      respHeaders.set(k, v);
    });
    respHeaders.set('x-saga-request-id', requestId);

    if (!res.body) {
      active--;
      finishWithoutBody(ctx, res.ok ? 'ok' : 'upstream_error', res.status, null);
      return new Response(null, { status: res.status, headers: respHeaders });
    }

    // Not recorded (see `capturable` above): hand the body straight back with no
    // tee. This is the load-bearing half of the guard — `consumeCapture` ends by
    // emitting `response_finished`, which without a `request_started` would be an
    // orphan the writer has no row to apply. Skipping the tee also spares a
    // probe the buffering it never needed.
    if (!ctx.startedEmitted) {
      active--;
      return new Response(res.body, { status: res.status, headers: respHeaders });
    }

    // ---- the tee: client branch returns NOW, capture branch reads later
    const [clientBranch, captureBranch] = res.body.tee();
    // From here on the client's abort must not reach the fetch (see above).
    teed = true;

    consumeCapture(captureBranch, res, ctx).catch((err) => {
      captureError(requestId, 'capture-consumer', err);
    });

    return new Response(clientBranch, { status: res.status, headers: respHeaders });
  }

  function finishWithoutBody(
    ctx: CaptureCtx,
    status: RequestStatus,
    httpStatus: number | null,
    error: { type: string; message: string } | null,
  ): void {
    // No `request_started` means there is no row to finish. `response_finished`
    // alone would be an orphan: the writer has no request to update, and the
    // session/agent rows this event assumes were never created.
    if (!ctx.startedEmitted) return;
    try {
      const result = ctx.observer?.finalize(
        status === 'ok'
          ? 'complete'
          : status === 'client_aborted'
            ? 'client_aborted'
            : 'upstream_error',
      );
      emitSafe({
        kind: 'response_finished',
        requestId: ctx.requestId,
        ts: Date.now(),
        status,
        httpStatus,
        latencyMs: performance.now() - ctx.t0,
        ttftMs: ctx.ttftMs,
        usage: result?.usage ?? { input: null, output: null, cacheRead: null, cacheWrite: null },
        stopReason: result?.stopReason ?? null,
        message: null,
        error,
        frameStats: result?.frameStats ?? { frames: 0, bytes: 0, parseErrors: 0 },
        redaction: { hits: [], flagged: false },
      });
    } catch (err) {
      captureError(ctx.requestId, 'finish-empty', err);
    } finally {
      if (ctx.sessionId) agentCorrelator.finish(ctx.sessionId, ctx.requestId);
    }
  }

  async function consumeCapture(
    // Exactly what `res.body.tee()` yields. Spelled as Response['body'] rather
    // than ReadableStream<Uint8Array> because bun-types declares the global
    // ReadableStream and pulls @types/node "*"; pinning the element type here
    // makes the two declarations collide on Uint8Array<ArrayBufferLike>.
    stream: NonNullable<Response['body']>,
    res: Response,
    ctx: CaptureCtx,
  ) {
    const contentType = res.headers.get('content-type') ?? '';
    const isSse = contentType.includes('text/event-stream');
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const parser = new SseParser();
    const chunks: Uint8Array[] = [];
    let buffered = 0;
    let truncated = false;
    let lastTick = 0;
    let finalStatus: RequestStatus = res.ok ? 'ok' : 'upstream_error';

    const pollTokens = (force = false): void => {
      const now = performance.now();
      if (!force && now - lastTick < tokenTickMs) return;
      lastTick = now;
      const obs = ctx.observer;
      const delta = obs?.deltaSinceLastPoll?.();
      if (obs && delta && delta.chars > 0) {
        emitSafe({
          kind: 'token_stream',
          requestId: ctx.requestId,
          ts: Date.now(),
          blockType: delta.blockType,
          deltaChars: delta.chars,
          outputTokens: obs.outputTokensSoFar(),
        });
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isSse && ctx.observer) {
          const frames = parser.push(decoder.decode(value, { stream: true }));
          for (const frame of frames) {
            try {
              ctx.observer.onFrame(frame);
            } catch (err) {
              captureError(ctx.requestId, 'observer.onFrame', err);
            }
            if (!ctx.firstTokenEmitted && ctx.observer.sawFirstContent()) {
              ctx.firstTokenEmitted = true;
              ctx.ttftMs = performance.now() - ctx.t0;
              emitSafe({
                kind: 'first_token',
                requestId: ctx.requestId,
                ts: Date.now(),
                ttftMs: ctx.ttftMs,
              });
            }
          }
          if (frames.length > 0) {
            pollTokens();
            drainToolUses(ctx);
          }
        } else {
          if (buffered < captureMax) {
            chunks.push(value);
            buffered += value.byteLength;
          } else {
            truncated = true;
          }
        }
      }
    } catch {
      finalStatus = ctx.clientSignal.aborted ? 'client_aborted' : 'capture_incomplete';
    } finally {
      reader.releaseLock();
    }
    // A client that walked away mid-stream still gets the full upstream
    // response recorded (the capture branch is no longer torn down with it),
    // so `done` is reached normally — the abort signal is the only evidence
    // left that nobody was listening. Never downgrade a real failure.
    if (finalStatus === 'ok' && ctx.clientSignal.aborted) finalStatus = 'client_aborted';

    try {
      if (isSse && ctx.observer) {
        for (const frame of parser.flush()) ctx.observer.onFrame(frame);
        pollTokens(true);
      } else if (!isSse && ctx.observer && buffered > 0 && !truncated) {
        const text = new TextDecoder().decode(concat(chunks, buffered));
        try {
          ctx.observer.onCompleteBody(JSON.parse(text));
        } catch {
          // non-JSON body (HTML error page, plain text): keep a redacted
          // snippet if the request failed, otherwise ignore content.
          if (!res.ok) {
            ctx.errorFromObserver = {
              type: `http_${res.status}`,
              message: scrubText(text.slice(0, 300)).value,
            };
          }
        }
      }

      const reason =
        finalStatus === 'ok'
          ? 'complete'
          : finalStatus === 'client_aborted'
            ? 'client_aborted'
            : 'upstream_error';
      const result = ctx.observer?.finalize(reason);

      const observerError = (
        ctx.observer as unknown as { error?: { type: string; message: string } | null }
      )?.error;
      const error =
        observerError ??
        ctx.errorFromObserver ??
        (res.ok
          ? null
          : { type: `http_${res.status}`, message: res.statusText || 'upstream error' });
      if (!res.ok && finalStatus === 'ok') finalStatus = 'upstream_error';

      let message = result?.message ?? null;
      let hits: Array<{ kind: string; count: number }> = [];
      let flagged = false;
      if (message) {
        const red = redactMessage(message);
        message = red.value;
        hits = red.hits;
        flagged = red.flagged;
      }
      if (result) {
        // Only what was NOT already emitted live at in-stream time.
        for (const tu of result.toolUses) {
          if (ctx.emittedToolBlocks.has(tu.blockIndex)) continue;
          emitSafe({
            kind: 'tool_use_observed',
            requestId: ctx.requestId,
            ts: Date.now(),
            blockIndex: tu.blockIndex,
            toolUseId: tu.toolUseId,
            name: tu.name,
            inputJson: tu.inputJson == null ? null : scrubText(tu.inputJson).value,
          });
        }
      }

      emitSafe({
        kind: 'response_finished',
        requestId: ctx.requestId,
        ts: Date.now(),
        status: finalStatus,
        httpStatus: res.status,
        latencyMs: performance.now() - ctx.t0,
        ttftMs: ctx.ttftMs,
        usage: result?.usage ?? { input: null, output: null, cacheRead: null, cacheWrite: null },
        stopReason: result?.stopReason ?? null,
        message,
        error,
        frameStats: result?.frameStats ?? { frames: 0, bytes: buffered, parseErrors: 0 },
        redaction: { hits, flagged },
      });
    } catch (err) {
      captureError(ctx.requestId, 'finalize', err);
    } finally {
      if (ctx.sessionId) agentCorrelator.finish(ctx.sessionId, ctx.requestId);
      active--;
    }
  }

  /** Emit tool_use_observed at real in-stream time as blocks complete. */
  function drainToolUses(ctx: CaptureCtx): void {
    try {
      const completed = ctx.observer?.drainCompletedToolUses?.() ?? [];
      for (const tu of completed) {
        if (ctx.emittedToolBlocks.has(tu.blockIndex)) continue;
        ctx.emittedToolBlocks.add(tu.blockIndex);
        emitSafe({
          kind: 'tool_use_observed',
          requestId: ctx.requestId,
          ts: Date.now(),
          blockIndex: tu.blockIndex,
          toolUseId: tu.toolUseId,
          name: tu.name,
          inputJson: tu.inputJson == null ? null : scrubText(tu.inputJson).value,
        });
      }
    } catch (err) {
      captureError(ctx.requestId, 'drain-tool-uses', err);
    }
  }

  const server = Bun.serve({
    hostname: host,
    port: opts.port,
    idleTimeout: 0,
    fetch: handle,
    error(err) {
      log.log('error', 'proxy', `server error: ${String(err)}`);
      return Response.json(
        { error: { type: 'saga_proxy_error', message: 'proxy failure; see SAGA logs' } },
        { status: 500 },
      );
    },
  });

  log.log('info', 'proxy', `listening on http://${host}:${server.port} -> ${opts.upstream}`);

  return {
    port: server.port ?? opts.port,
    host,
    upstream: opts.upstream,
    activeRequests: () => active,
    stop: () => server.stop(true),
    fetchHandler: handle,
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
