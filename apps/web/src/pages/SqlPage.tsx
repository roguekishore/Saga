import type { SqlResult } from '@saga/contracts';
import { SqlResultSchema } from '@saga/contracts';
import {
  Badge,
  Button,
  Card,
  cn,
  dur,
  EmptyState,
  ease,
  fmtMs,
  Kbd,
  Select,
  Skeleton,
  Tip,
} from '@saga/ui';
import { useMutation } from '@tanstack/react-query';
import { Download, Play, Save, TerminalSquare, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Page } from '../shell/Page';

/**
 * SQL Explorer over the read-only endpoint. The guards live server-side
 * (readonly connection, SELECT-only, row cap, kill-timeout); this page's job
 * is a fast loop: edit → Ctrl+Enter → table → CSV.
 */

const EXAMPLES: Array<{ label: string; sql: string }> = [
  {
    label: 'schema — tables',
    sql: `SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name`,
  },
  {
    label: 'tokens by model, 7d',
    sql: `SELECT model,\n       COUNT(*) AS requests,\n       SUM(input_tokens) AS input_tokens,\n       SUM(output_tokens) AS output_tokens\nFROM requests\nWHERE ts >= (strftime('%s','now') - 7*86400) * 1000\nGROUP BY model ORDER BY output_tokens DESC`,
  },
  {
    label: 'slowest requests today',
    sql: `SELECT request_id, model, latency_ms, ttft_ms, status\nFROM requests\nWHERE ts >= (strftime('%s','now','start of day')) * 1000\nORDER BY latency_ms DESC LIMIT 20`,
  },
  {
    label: 'dedup effectiveness',
    sql: `SELECT COUNT(*) AS message_rows, SUM(refs) AS total_references,\n       ROUND(1.0 * SUM(refs) / COUNT(*), 2) AS avg_refs_per_message\nFROM messages`,
  },
  {
    label: 'redaction hits by kind',
    sql: `SELECT j.value ->> 'kind' AS kind, SUM(j.value ->> 'count') AS hits\nFROM requests, json_each(requests.redaction_hits_json) AS j\nGROUP BY kind ORDER BY hits DESC`,
  },
];

interface Saved {
  name: string;
  sql: string;
}

export function SqlPage() {
  const [sql, setSql] = useState(EXAMPLES[1]!.sql);
  const [saved, setSaved] = useState<Saved[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('saga-sql-saved') ?? '[]') as Saved[];
    } catch {
      return [];
    }
  });
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const run = useMutation({
    mutationFn: async (q: string): Promise<SqlResult> => {
      const res = await fetch('/api/sql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: q }),
      });
      const json = (await res.json()) as SqlResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      return SqlResultSchema.parse(json);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run.mutate(sql);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sql, run]);

  const persistSaved = (next: Saved[]): void => {
    setSaved(next);
    localStorage.setItem('saga-sql-saved', JSON.stringify(next));
  };

  const exportCsv = (): void => {
    const r = run.data;
    if (!r) return;
    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const csv = [r.columns.map(esc).join(','), ...r.rows.map((row) => row.map(esc).join(','))].join(
      '\n',
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `saga-query-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Page flush className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" onClick={() => run.mutate(sql)} disabled={run.isPending}>
          <Play className="size-3.5" /> run
          <Kbd className="border-accent-ink/30 bg-transparent text-accent-ink/90">⌃⏎</Kbd>
        </Button>
        <Select
          value=""
          aria-label="example queries"
          onChange={(e) => {
            const ex = EXAMPLES.find((x) => x.label === e.target.value);
            if (ex) setSql(ex.sql);
          }}
        >
          <option value="" disabled>
            examples…
          </option>
          {EXAMPLES.map((ex) => (
            <option key={ex.label} value={ex.label}>
              {ex.label}
            </option>
          ))}
        </Select>
        {saved.length > 0 ? (
          <Select
            value=""
            aria-label="saved queries"
            onChange={(e) => {
              const s = saved.find((x) => x.name === e.target.value);
              if (s) setSql(s.sql);
            }}
          >
            <option value="" disabled>
              saved…
            </option>
            {saved.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Button
          onClick={() => {
            const name = prompt('save query as…')?.trim();
            if (name) persistSaved([...saved.filter((s) => s.name !== name), { name, sql }]);
          }}
        >
          <Save className="size-3.5" /> save
        </Button>
        {saved.length > 0 ? (
          <Button variant="ghost" onClick={() => persistSaved([])}>
            <Trash2 className="size-3.5" /> clear saved
          </Button>
        ) : null}
        <span className="ml-auto text-[11px] text-ink-faint">
          read-only · SELECT/WITH only · 1000-row cap · 2.5s kill-timeout · runs off the event loop
        </span>
      </div>

      <textarea
        ref={areaRef}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        spellCheck={false}
        aria-label="SQL query"
        className={cn(
          'min-h-40 w-full shrink-0 resize-y rounded-[10px] border border-line bg-surface p-3',
          'font-mono text-[12.5px] leading-5 text-ink',
          'transition-colors duration-(--dur-1) hover:border-line-strong focus:border-line-strong',
        )}
      />

      <AnimatePresence>
        {run.isError ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: dur.base, ease: ease.out }}
          >
            <Card className="border-err/40 bg-err/5 px-3.5 py-2.5 font-mono text-[12.5px] text-err">
              {String(run.error?.message ?? run.error)}
            </Card>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {run.data ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15, ease: ease.out }}
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <div className="flex items-center gap-2">
            <Badge tone="ok" className="font-mono tabular-nums">
              {run.data.rowCount} rows
            </Badge>
            <span className="font-mono text-[11.5px] tabular-nums text-ink-dim">
              {fmtMs(run.data.elapsedMs)}
            </span>
            {run.data.truncated ? (
              <Tip content="The endpoint caps result sets at 1000 rows. Narrow the query for the full picture.">
                <span>
                  <Badge tone="warn">truncated</Badge>
                </span>
              </Tip>
            ) : null}
            <Button variant="ghost" className="ml-auto" onClick={exportCsv}>
              <Download className="size-3.5" /> CSV
            </Button>
          </div>
          <Card className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead className="sticky top-0 z-10 bg-raised">
                <tr>
                  {run.data.columns.map((c2) => (
                    <th
                      key={c2}
                      className="whitespace-nowrap px-3 py-1.5 text-left font-mono text-[11.5px] font-semibold text-ink-dim"
                    >
                      {c2}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.data.rows.map((row, i) => (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: SQL rows have no stable id
                    key={i}
                    className="border-t border-line/40 transition-colors duration-(--dur-1) hover:bg-raised/40"
                  >
                    {row.map((cell, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: SQL cells are positional
                      <td key={j} className="max-w-[380px] truncate px-3 py-1 font-mono">
                        {cell == null ? (
                          <span className="italic text-ink-faint">NULL</span>
                        ) : (
                          String(cell)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </motion.div>
      ) : run.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : !run.isError ? (
        <EmptyState icon={<TerminalSquare />} title="Run a query" className="flex-1">
          The endpoint executes on its own read-only connection in a worker thread — a runaway query
          gets terminated without ever blocking capture.
        </EmptyState>
      ) : null}
    </Page>
  );
}
