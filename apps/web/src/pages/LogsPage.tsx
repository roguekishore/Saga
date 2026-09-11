import type { LogPage } from '@saga/contracts';
import { LogPageSchema } from '@saga/contracts';
import { Badge, Button, cn, EmptyState, fmtInt, fmtTime, Input, Select } from '@saga/ui';
import { FilterX, Pause, Play, ScrollText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Page } from '../shell/Page';

/**
 * Logs Explorer — SAGA's OWN logs (ring buffer, scrubbed at write). Upstream
 * gateway logs are outside the wrapper boundary by architecture; the page
 * says so instead of pretending.
 */

const LEVEL_TONE: Record<string, string> = {
  debug: 'text-ink-faint',
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-err',
};

export function LogsPage() {
  const [lines, setLines] = useState<LogPage['items']>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState('');
  const [filter, setFilter] = useState('');
  const afterRef = useRef(-1);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    const tick = async (): Promise<void> => {
      if (stop || paused) return;
      try {
        const res = await fetch(`/api/logs?after=${afterRef.current}&limit=500`);
        const page = LogPageSchema.parse(await res.json());
        if (page.items.length > 0) {
          afterRef.current = page.nextAfter ?? afterRef.current;
          // Dedupe on seq: overlapping ticks (remounts, slow responses) must
          // not double-append the same lines.
          setLines((cur) => {
            const seen = new Set(cur.map((l) => l.seq));
            return [...cur, ...page.items.filter((i) => !seen.has(i.seq))].slice(-4000);
          });
        }
      } catch {
        // collector down; the shell banner already says so
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [paused]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `lines` triggers scroll-to-bottom on new entries
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lines, paused]);

  const visible = lines.filter((l) => {
    if (level && l.level !== level) return false;
    if (filter && !`${l.scope} ${l.message}`.toLowerCase().includes(filter.toLowerCase()))
      return false;
    return true;
  });

  return (
    <Page flush className="flex flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button variant={paused ? 'solid' : 'outline'} onClick={() => setPaused((p) => !p)}>
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          {paused ? 'resume' : 'pause'}
        </Button>
        <Input
          placeholder="filter scope or message…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <Select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="log level">
          <option value="">all levels</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </Select>
        <span className="ml-auto text-right text-[11px] leading-4 text-ink-faint">
          SAGA's own channel · scrubbed at write · upstream logs are outside the wrapper boundary
        </span>
      </div>

      {/* No per-row entrances here: lines arrive continuously and the surface must stay cheap. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[12px] leading-5">
        {visible.length === 0 ? (
          lines.length === 0 ? (
            <EmptyState icon={<ScrollText />} title="No log lines yet" className="m-6 font-sans">
              SAGA's own process logs stream in here as they happen — scrubbed at write, polled from
              the in-memory ring buffer. Upstream gateway logs are outside the wrapper boundary.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<FilterX />}
              title="No lines match the current filters"
              className="m-6 font-sans"
              action={
                <Button
                  onClick={() => {
                    setFilter('');
                    setLevel('');
                  }}
                >
                  clear filters
                </Button>
              }
            >
              <span className="font-mono tabular-nums">{fmtInt(lines.length)}</span> buffered lines
              are hidden by the active filter and level.
            </EmptyState>
          )
        ) : (
          visible.map((l) => (
            <div
              key={l.seq}
              className="flex gap-2 whitespace-pre-wrap break-all rounded-sm px-1.5 transition-colors duration-(--dur-1) hover:bg-raised/50"
            >
              <span className="shrink-0 tabular-nums text-ink-faint">{fmtTime(l.ts)}</span>
              <span className={cn('w-11 shrink-0 font-semibold', LEVEL_TONE[l.level])}>
                {l.level}
              </span>
              <Badge className="shrink-0 font-mono">{l.scope}</Badge>
              <span>{l.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </Page>
  );
}
