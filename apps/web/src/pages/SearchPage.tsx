import {
  Badge,
  Card,
  dur,
  EmptyState,
  fmtDateTime,
  Input,
  listContainer,
  listItem,
  Skeleton,
  STAGGER_CAP,
  shortId,
} from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon, SearchX } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { Page } from '../shell/Page';

/**
 * Search Center: FTS5 over every captured (redacted) message body. The
 * search index is contentless — snippets are computed server-side from
 * decompressed hits, which is why they arrive already highlighted-able.
 */
export function SearchPage() {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const t = setTimeout(() => setQ(input.trim()), 220);
    return () => clearTimeout(t);
  }, [input]);

  const res = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search(q, 50),
    enabled: q.length >= 2,
  });

  const mark = (snippet: string): React.ReactNode => {
    const first = q.split(/\s+/)[0] ?? '';
    if (!first) return snippet;
    const i = snippet.toLowerCase().indexOf(first.toLowerCase());
    if (i === -1) return snippet;
    return (
      <>
        {snippet.slice(0, i)}
        <mark className="rounded-sm bg-accent/25 px-0.5 text-inherit">
          {snippet.slice(i, i + first.length)}
        </mark>
        {snippet.slice(i + first.length)}
      </>
    );
  };

  const data = res.data;

  return (
    <Page className="mx-auto max-w-3xl">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
        <Input
          ref={ref}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="search every captured prompt and response…"
          className="h-10 pl-9 text-[14px]"
        />
      </div>

      {q.length < 2 ? (
        <EmptyState icon={<SearchIcon />} title="Type at least two characters">
          Full-text search runs over redacted message bodies via SQLite FTS5. Retention applies:
          bodies dropped by the archive tier are no longer searchable — by design.
        </EmptyState>
      ) : res.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-28" />
          {Array.from({ length: 3 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders, no data identity
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={<SearchX />} title={`No matches for “${q}”`}>
          Nothing in the index matches this query. The index covers retained bodies only — anything
          dropped by the archive tier is no longer searchable, by design.
        </EmptyState>
      ) : (
        <>
          <div className="px-1 font-mono text-[11px] tabular-nums text-ink-faint">
            {data.items.length} hits · {data.totalMs.toFixed(1)}ms
          </div>
          <AnimatePresence mode="popLayout">
            <motion.div
              key={q}
              variants={listContainer}
              initial="initial"
              animate="animate"
              exit={{ opacity: 0, transition: { duration: dur.fast } }}
              className="space-y-2"
            >
              {data.items.map((hit, i) => (
                <motion.div
                  key={`${hit.messageId}-${hit.requestId}`}
                  variants={i < STAGGER_CAP ? listItem : undefined}
                >
                  <Card className="px-3.5 py-2.5 transition-colors duration-(--dur-1) hover:border-line-strong">
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={
                          hit.role === 'assistant' ? 'ok' : hit.role === 'system' ? 'warn' : 'info'
                        }
                      >
                        {hit.role}
                      </Badge>
                      <Link
                        to={`/requests/${hit.requestId}`}
                        className="font-mono text-[12px] text-accent hover:underline"
                      >
                        {shortId(hit.requestId)}
                      </Link>
                      <Link
                        to={`/sessions/${hit.sessionId}`}
                        className="font-mono text-[11px] text-ink-faint hover:underline"
                      >
                        {shortId(hit.sessionId)}
                      </Link>
                      <span className="ml-auto font-mono text-[10.5px] tabular-nums text-ink-faint">
                        {fmtDateTime(hit.ts)}
                      </span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-dim">
                      {mark(hit.snippet)}
                    </p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </Page>
  );
}
