import { Badge, Card, EmptyState, fmtDateTime, Input, Skeleton, shortId } from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';

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

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
        <Input
          ref={ref}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="search every captured prompt and response…"
          className="h-10 pl-9 text-[14px]"
        />
      </div>

      {q.length < 2 ? (
        <EmptyState title="Type at least two characters">
          Full-text search runs over redacted message bodies via SQLite FTS5. Retention applies:
          bodies dropped by the archive tier are no longer searchable — by design.
        </EmptyState>
      ) : res.isLoading ? (
        <Skeleton className="h-40" />
      ) : (res.data?.items.length ?? 0) === 0 ? (
        <EmptyState title={`No matches for “${q}”`} />
      ) : (
        <>
          <div className="text-[11.5px] text-ink-faint">
            {res.data!.items.length} hits · {res.data!.totalMs.toFixed(1)}ms
          </div>
          <div className="space-y-2">
            {res.data!.items.map((hit) => (
              <Card key={`${hit.messageId}-${hit.requestId}`} className="px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={hit.role === 'assistant' ? 'ok' : hit.role === 'system' ? 'warn' : 'info'}
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
                  <span className="ml-auto text-[11px] text-ink-faint">{fmtDateTime(hit.ts)}</span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-dim">
                  {mark(hit.snippet)}
                </p>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
