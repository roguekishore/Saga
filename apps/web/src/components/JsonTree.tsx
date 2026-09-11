import { Button, cn } from '@saga/ui';
import { useMemo, useState } from 'react';

/**
 * Dependency-free collapsible JSON view. Monaco is deliberately NOT here —
 * it never belongs in the initial bundle; the diff editor arrives lazily in
 * P3 where it earns its weight.
 */

const MAX_AUTO_PARSE = 400_000;

export function JsonView({ json, className }: { json: string; className?: string }) {
  const [forceRaw, setForceRaw] = useState(false);
  const parsed = useMemo(() => {
    if (forceRaw || json.length > MAX_AUTO_PARSE) return undefined;
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return undefined;
    }
  }, [json, forceRaw]);

  return (
    <div className={cn('font-mono text-[12px] leading-5', className)}>
      <div className="mb-1.5 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setForceRaw((v) => !v)}>
          {forceRaw || parsed === undefined ? 'tree view' : 'raw text'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigator.clipboard.writeText(json).catch(() => {})}
        >
          copy
        </Button>
        <span className="text-[11px] text-ink-faint">{json.length.toLocaleString()} chars</span>
        {json.length > MAX_AUTO_PARSE ? (
          <span className="text-[11px] text-warn">large payload — raw view</span>
        ) : null}
      </div>
      {parsed === undefined ? (
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas p-3">
          {json}
        </pre>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-md border border-line bg-canvas p-3">
          <Node value={parsed} depth={0} name={undefined} />
        </div>
      )}
    </div>
  );
}

function Node({ value, name, depth }: { value: unknown; name: string | undefined; depth: number }) {
  const label =
    name !== undefined ? <span className="text-info">{JSON.stringify(name)}: </span> : null;

  if (value === null || typeof value !== 'object') {
    return (
      <div style={{ paddingLeft: depth ? 14 : 0 }}>
        {label}
        <Primitive value={value} />
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const open = depth < 2 && entries.length <= 50;
  const brackets = Array.isArray(value) ? '[]' : '{}';

  if (entries.length === 0) {
    return (
      <div style={{ paddingLeft: depth ? 14 : 0 }}>
        {label}
        <span className="text-ink-faint">{brackets}</span>
      </div>
    );
  }

  return (
    <details open={open} style={{ paddingLeft: depth ? 14 : 0 }}>
      <summary className="cursor-pointer select-none list-none marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="mr-1 text-ink-faint">▸</span>
        {label}
        <span className="text-ink-faint">
          {brackets[0]} {entries.length} {brackets[1]}
        </span>
      </summary>
      {entries.map(([k, v]) => (
        <Node key={k} name={Array.isArray(value) ? undefined : k} value={v} depth={depth + 1} />
      ))}
    </details>
  );
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-ink-faint">null</span>;
  if (typeof value === 'string') {
    const isRedacted = value.includes('[REDACTED:');
    return (
      <span
        className={cn('whitespace-pre-wrap break-all', isRedacted ? 'text-warn' : 'text-ink-dim')}
      >
        {JSON.stringify(value)}
      </span>
    );
  }
  if (typeof value === 'number') return <span className="text-accent">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-inferred">{String(value)}</span>;
  return <span>{String(value)}</span>;
}
