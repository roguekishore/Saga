import type { NormalizedEvent, RequestSummary, WsMetrics } from '@saga/contracts';
import { create } from 'zustand';

/**
 * The live feed: request rows assembled from WebSocket events, newest first,
 * bounded. REST fills history on mount; the socket only patches deltas in.
 */

export interface LiveRow extends RequestSummary {
  /** Live-updating streamed character count (from token_stream ticks). */
  liveChars: number;
}

const MAX_ROWS = 500;

function rowFromStarted(ev: Extract<NormalizedEvent, { kind: 'request_started' }>): LiveRow {
  return {
    requestId: ev.requestId,
    ts: ev.ts,
    sessionId: ev.sessionId,
    adapterId: ev.adapterId,
    provider: ev.provider,
    model: ev.model,
    endpoint: ev.endpoint,
    stream: ev.stream,
    status: null,
    httpStatus: null,
    latencyMs: null,
    ttftMs: null,
    inputTokens: null,
    outputTokens: null,
    messageCount: ev.request.system.length + ev.request.messages.length,
    toolUseCount: 0,
    agentId: null,
    errorMessage: null,
    redactionFlagged: ev.redaction.flagged,
    liveChars: 0,
  };
}

interface LiveState {
  connected: boolean;
  paused: boolean;
  rows: LiveRow[];
  pending: NormalizedEvent[];
  metrics: WsMetrics | null;
  eventsSeen: number;
  captureErrors: number;
  seed(rows: RequestSummary[]): void;
  applyEvent(ev: NormalizedEvent): void;
  setConnected(connected: boolean): void;
  setMetrics(m: WsMetrics): void;
  togglePause(): void;
  clear(): void;
}

function patch(rows: LiveRow[], requestId: string, fn: (r: LiveRow) => LiveRow): LiveRow[] {
  const i = rows.findIndex((r) => r.requestId === requestId);
  if (i === -1) return rows;
  const next = rows.slice();
  next[i] = fn(rows[i]!);
  return next;
}

function apply(
  rows: LiveRow[],
  ev: NormalizedEvent,
  bump: (field: 'captureErrors') => void,
): LiveRow[] {
  switch (ev.kind) {
    case 'request_started': {
      const next = [rowFromStarted(ev), ...rows.filter((r) => r.requestId !== ev.requestId)];
      return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
    }
    case 'first_token':
      return patch(rows, ev.requestId, (r) => ({ ...r, ttftMs: ev.ttftMs }));
    case 'token_stream':
      return patch(rows, ev.requestId, (r) => ({
        ...r,
        liveChars: r.liveChars + ev.deltaChars,
        outputTokens: ev.outputTokens ?? r.outputTokens,
      }));
    case 'tool_use_observed':
      return patch(rows, ev.requestId, (r) => ({ ...r, toolUseCount: r.toolUseCount + 1 }));
    case 'response_finished':
      return patch(rows, ev.requestId, (r) => ({
        ...r,
        status: ev.status,
        httpStatus: ev.httpStatus,
        latencyMs: ev.latencyMs,
        ttftMs: ev.ttftMs ?? r.ttftMs,
        inputTokens: ev.usage.input,
        outputTokens: ev.usage.output,
        errorMessage: ev.error?.message ?? null,
        redactionFlagged: r.redactionFlagged || ev.redaction.flagged,
      }));
    case 'capture_error':
      bump('captureErrors');
      return rows;
    default:
      return rows;
  }
}

export const useLive = create<LiveState>((set, get) => ({
  connected: false,
  paused: false,
  rows: [],
  pending: [],
  metrics: null,
  eventsSeen: 0,
  captureErrors: 0,

  seed(seedRows) {
    const existing = new Set(get().rows.map((r) => r.requestId));
    const merged = [
      ...get().rows,
      ...seedRows.filter((r) => !existing.has(r.requestId)).map((r) => ({ ...r, liveChars: 0 })),
    ].sort((a, b) => b.ts - a.ts || (a.requestId < b.requestId ? 1 : -1));
    set({ rows: merged.slice(0, MAX_ROWS) });
  },

  applyEvent(ev) {
    const s = get();
    const bump = () => set((st) => ({ captureErrors: st.captureErrors + 1 }));
    if (s.paused) {
      set({ pending: [...s.pending.slice(-999), ev], eventsSeen: s.eventsSeen + 1 });
      return;
    }
    set({ rows: apply(s.rows, ev, bump), eventsSeen: s.eventsSeen + 1 });
  },

  setConnected(connected) {
    set({ connected });
  },

  setMetrics(m) {
    set({ metrics: m });
  },

  togglePause() {
    const s = get();
    if (!s.paused) {
      set({ paused: true });
      return;
    }
    let rows = s.rows;
    const bump = () => set((st) => ({ captureErrors: st.captureErrors + 1 }));
    for (const ev of s.pending) rows = apply(rows, ev, bump);
    set({ paused: false, pending: [], rows });
  },

  clear() {
    set({ rows: [], pending: [] });
  },
}));
