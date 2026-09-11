import {
  Badge,
  Button,
  cn,
  EmptyState,
  fmtInt,
  fmtMs,
  fmtTime,
  fmtTokens,
  Input,
  Kbd,
  Select,
  StatusPill,
  Tip,
  TokenValue,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Eraser, Pause, Play, Radio, ShieldAlert, Wrench, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { type LiveRow, useLive } from '../lib/live-store';
import { webglAvailable } from '../lib/webgl';
import { Page } from '../shell/Page';

const AmbientField = lazy(() => import('../components/AmbientField'));

/**
 * Chrome-DevTools-for-AI-requests. Virtualized from the first row — the
 * 200ms dashboard budget is a design input, not an optimization pass.
 * Keys: j/k move · Enter opens · p pauses · / filters.
 */

const GRID =
  'grid grid-cols-[70px_88px_minmax(150px,1.2fr)_minmax(110px,1fr)_70px_76px_64px_64px_54px_44px] items-center gap-x-3';

/** Rows younger than this get the one-shot materialization treatment. */
const FRESH_MS = 1500;

const prefetchInspector = (): void => {
  void import('./RequestInspectorPage');
};

export function LiveMonitorPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const agentFilter = params.get('agent');

  const rows = useLive((s) => s.rows);
  const paused = useLive((s) => s.paused);
  const pendingCount = useLive((s) => s.pending.length);
  const eventsSeen = useLive((s) => s.eventsSeen);
  const togglePause = useLive((s) => s.togglePause);
  const clear = useLive((s) => s.clear);
  const seed = useLive((s) => s.seed);

  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // History fill: the socket only carries deltas.
  const history = useQuery({
    queryKey: ['requests-seed'],
    queryFn: () => api.requests({ limit: 200 }),
  });
  useEffect(() => {
    if (history.data) seed(history.data.items);
  }, [history.data, seed]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (agentFilter && r.agentId !== agentFilter) return false;
      if (
        statusFilter === 'in_flight' ? r.status !== null : statusFilter && r.status !== statusFilter
      )
        return false;
      if (!q) return true;
      return (
        (r.model ?? '').toLowerCase().includes(q) ||
        r.adapterId.toLowerCase().includes(q) ||
        r.endpoint.toLowerCase().includes(q) ||
        r.sessionId.toLowerCase().includes(q) ||
        r.requestId.toLowerCase().includes(q) ||
        (r.errorMessage ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, filter, statusFilter, agentFilter]);

  const streaming = useMemo(() => rows.filter((r) => r.status === null).length, [rows]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 32,
    overscan: 16,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inField = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (inField) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => Math.min(visible.length - 1, s + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
      } else if (e.key === 'Enter') {
        const row = visible[selected];
        if (row) navigate(`/requests/${row.requestId}`);
      } else if (e.key === 'p') {
        togglePause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected, navigate, togglePause]);

  useEffect(() => {
    virtualizer.scrollToIndex(Math.min(selected, Math.max(0, visible.length - 1)));
  }, [selected, visible.length, virtualizer]);

  const now = Date.now();

  return (
    <Page flush className="flex flex-col">
      {/* -------------------------------------------------------- toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Tip
          content={paused ? `Resume (buffering ${pendingCount} events)` : 'Pause the stream (p)'}
        >
          <Button variant={paused ? 'solid' : 'outline'} onClick={togglePause} aria-label="pause">
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? `resume · ${pendingCount}` : 'pause'}
          </Button>
        </Tip>
        <Input
          ref={searchRef}
          placeholder="filter — model, adapter, session, error…  ( / )"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="status filter"
        >
          <option value="">all statuses</option>
          <option value="in_flight">streaming</option>
          <option value="ok">ok</option>
          <option value="upstream_error">error</option>
          <option value="client_aborted">aborted</option>
          <option value="capture_incomplete">partial</option>
        </Select>
        {agentFilter ? (
          <Tip content="Showing only requests correlated to this agent — correlation is a SAGA heuristic.">
            <button
              type="button"
              onClick={() => setParams({})}
              className="inline-flex cursor-pointer items-center gap-1 rounded border border-dashed border-inferred/60 px-1.5 py-px text-[10.5px] font-medium text-inferred hover:bg-inferred/10"
            >
              agent {agentFilter.slice(0, 14)}… <X className="size-3" />
            </button>
          </Tip>
        ) : null}
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums text-ink-faint">
          {streaming > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-info">
              <span className="relative inline-flex size-1.5">
                <span className="absolute inset-0 animate-[saga-ping_1.4s_var(--ease-out)_infinite] rounded-full bg-info motion-reduce:animate-none" />
                <span className="relative inline-flex size-1.5 rounded-full bg-info" />
              </span>
              {streaming} streaming
            </span>
          ) : null}
          <span>{fmtInt(eventsSeen)} events</span>
          <span>
            {visible.length}/{rows.length} rows
          </span>
          <Button variant="ghost" onClick={clear} aria-label="clear">
            <Eraser className="size-3.5" /> clear
          </Button>
        </div>
      </div>

      {/* --------------------------------------------------------- header */}
      <div
        className={cn(
          GRID,
          'shrink-0 border-b border-line bg-surface px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint',
        )}
      >
        <span>time</span>
        <span>status</span>
        <span>model</span>
        <span>adapter · endpoint</span>
        <span className="text-right">in</span>
        <span className="text-right">out</span>
        <span className="text-right">ttft</span>
        <span className="text-right">total</span>
        <span className="text-right">msgs</span>
        <span className="text-right">…</span>
      </div>

      {/* ----------------------------------------------------------- rows */}
      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="relative flex h-full items-center justify-center overflow-hidden">
            {rows.length === 0 && webglAvailable() ? (
              <Suspense fallback={null}>
                <div className="pointer-events-none absolute inset-0 opacity-60">
                  <AmbientField />
                </div>
              </Suspense>
            ) : null}
            <EmptyState
              icon={<Radio />}
              title={rows.length === 0 ? 'Listening for traffic' : 'Nothing matches'}
              className="relative border-0"
            >
              {rows.length === 0
                ? 'No requests captured yet. Route a client through the proxy on :8787, or seed the fixture corpus — the feed lights up the moment bytes flow.'
                : 'Adjust the filter — the stream keeps flowing underneath.'}
            </EmptyState>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const r = visible[v.index]!;
              return (
                <RowLine
                  key={r.requestId}
                  row={r}
                  fresh={now - r.ts < FRESH_MS}
                  selected={v.index === selected}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: v.size,
                    transform: `translateY(${v.start}px)`,
                  }}
                  onClick={() => {
                    setSelected(v.index);
                    navigate(`/requests/${r.requestId}`);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line px-3 text-[10.5px] text-ink-faint">
        <span className="inline-flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>⏎</Kbd> inspect
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>p</Kbd> pause
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>/</Kbd> filter
        </span>
        {paused ? <Badge tone="warn">paused — buffering {pendingCount}</Badge> : null}
      </div>
    </Page>
  );
}

function RowLine({
  row: r,
  fresh,
  selected,
  style,
  onClick,
}: {
  row: LiveRow;
  fresh: boolean;
  selected: boolean;
  style: React.CSSProperties;
  onClick: () => void;
}) {
  const live = r.status === null;
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerEnter={prefetchInspector}
      style={style}
      className={cn(
        GRID,
        'w-full cursor-pointer border-b border-line/50 px-3 text-left text-[12px] tabular-nums',
        'transition-colors duration-(--dur-1)',
        selected ? 'bg-sel' : 'hover:bg-raised/60',
        r.status === 'upstream_error' && 'bg-err/[0.04]',
        fresh && 'animate-[saga-rise_var(--dur-3)_var(--ease-out)]',
      )}
    >
      {/* one-shot materialization wash for rows that just arrived */}
      {fresh ? (
        <span className="pointer-events-none absolute inset-0 animate-[saga-wash_900ms_var(--ease-out)_1_both] bg-accent" />
      ) : null}
      {selected ? (
        <span className="absolute inset-y-0.5 left-0 w-[2px] rounded-full bg-accent" />
      ) : null}
      <span className="font-mono text-[11.5px] text-ink-faint">{fmtTime(r.ts)}</span>
      <StatusPill status={r.status} />
      <span className="truncate font-mono text-[12px]">
        {r.model ?? <span className="text-ink-faint">{r.endpoint}</span>}
      </span>
      <span className="truncate text-ink-dim">
        {r.adapterId}
        <span className="text-ink-faint"> · {r.endpoint}</span>
      </span>
      <span className="text-right">
        <TokenValue usage={r.inputTokens} naReason="Not reported (yet) for this request." />
      </span>
      <span className="text-right">
        {live && r.outputTokens == null ? (
          <span className="font-mono text-[11.5px] text-info">
            {fmtTokens(r.liveChars)}ch
            <span className="ml-px inline-block animate-[saga-pulse_1.1s_var(--ease-in-out)_infinite] motion-reduce:animate-none">
              ▍
            </span>
          </span>
        ) : (
          <TokenValue usage={r.outputTokens} naReason="Not reported for this request." />
        )}
      </span>
      <span className="text-right font-mono text-[11.5px] text-ink-dim">{fmtMs(r.ttftMs)}</span>
      <span className="text-right font-mono text-[11.5px]">{fmtMs(r.latencyMs)}</span>
      <span className="text-right font-mono text-ink-dim">{r.messageCount}</span>
      <span className="flex items-center justify-end gap-1 text-ink-faint">
        {r.toolUseCount > 0 ? (
          <Tip content={`${r.toolUseCount} tool call(s) observed`}>
            <span className="inline-flex items-center">
              <Wrench className="size-3" />
            </span>
          </Tip>
        ) : null}
        {r.redactionFlagged ? (
          <Tip content="Fail-closed redaction fired: an unrecognized high-entropy blob was scrubbed from this request.">
            <span className="inline-flex items-center">
              <ShieldAlert className="size-3 text-warn" />
            </span>
          </Tip>
        ) : null}
      </span>
    </button>
  );
}
