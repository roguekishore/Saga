import type { Logger, NormalizedEvent } from '@saga/contracts';

/**
 * Minimal OTLP/HTTP (JSON) trace export: one span per finished request,
 * batched, fire-and-forget. Enabled by SAGA_OTLP_ENDPOINT — e.g.
 * http://127.0.0.1:4318 (the /v1/traces path is appended if missing).
 * Only what SAGA actually measured goes out; token attributes carry their
 * provenance in the attribute name, same honesty rules as the UI.
 */

interface OtlpAttr {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}

function hex(input: string, bytes: number): string {
  // Deterministic ids from the request id: same request → same trace/span id.
  const h = new Bun.CryptoHasher('sha256');
  h.update(input);
  return h.digest('hex').slice(0, bytes * 2);
}

function attr(key: string, value: string | number): OtlpAttr {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { key, value: { intValue: String(value) } };
  }
  if (typeof value === 'number') return { key, value: { doubleValue: value } };
  return { key, value: { stringValue: value } };
}

export function createOtelExporter(
  endpoint: string,
  log: Logger,
  flushMs = 3000,
): { subscriber: (ev: NormalizedEvent) => void; stop: () => void } {
  const url = endpoint.includes('/v1/traces')
    ? endpoint
    : `${endpoint.replace(/\/$/, '')}/v1/traces`;
  const started = new Map<string, { model: string | null; adapterId: string; sessionId: string }>();
  let spans: unknown[] = [];

  const subscriber = (ev: NormalizedEvent): void => {
    if (ev.kind === 'request_started') {
      started.set(ev.requestId, {
        model: ev.model,
        adapterId: ev.adapterId,
        sessionId: ev.sessionId,
      });
      if (started.size > 5000) {
        const first = started.keys().next().value;
        if (first) started.delete(first);
      }
      return;
    }
    if (ev.kind !== 'response_finished') return;
    const meta = started.get(ev.requestId);
    started.delete(ev.requestId);

    const startMs = ev.ts - ev.latencyMs;
    const attrs: OtlpAttr[] = [
      attr('saga.adapter', meta?.adapterId ?? 'unknown'),
      attr('saga.session_id', meta?.sessionId ?? 'unknown'),
      attr('saga.status', ev.status),
    ];
    if (ev.httpStatus != null) attrs.push(attr('http.response.status_code', ev.httpStatus));
    if (ev.usage.input) {
      attrs.push(attr(`gen_ai.usage.input_tokens.${ev.usage.input.source}`, ev.usage.input.value));
    }
    if (ev.usage.output) {
      attrs.push(
        attr(`gen_ai.usage.output_tokens.${ev.usage.output.source}`, ev.usage.output.value),
      );
    }
    if (ev.ttftMs != null) attrs.push(attr('saga.ttft_ms', ev.ttftMs));

    spans.push({
      traceId: hex(ev.requestId, 16),
      spanId: hex(`${ev.requestId}:span`, 8),
      name: meta?.model ?? 'request',
      kind: 3, // SPAN_KIND_CLIENT
      startTimeUnixNano: String(Math.round(startMs * 1e6)),
      endTimeUnixNano: String(Math.round(ev.ts * 1e6)),
      status: { code: ev.status === 'ok' ? 1 : 2 },
      attributes: attrs,
    });
  };

  const flush = (): void => {
    if (spans.length === 0) return;
    const batch = spans;
    spans = [];
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [attr('service.name', 'saga-proxy')] },
            scopeSpans: [{ scope: { name: 'saga' }, spans: batch }],
          },
        ],
      }),
    }).catch((err) =>
      log.log('warn', 'otel', `export failed (${batch.length} spans): ${String(err)}`),
    );
  };

  const timer = setInterval(flush, flushMs);
  return {
    subscriber,
    stop: () => {
      clearInterval(timer);
      flush();
    },
  };
}
