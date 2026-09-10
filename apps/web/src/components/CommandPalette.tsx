import { fmtTime, StatusPill, shortId } from '@saga/ui';
import { Command } from 'cmdk';
import { Activity, BarChart3, Database, Layers, Radio, Search as SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLive } from '../lib/live-store';

/**
 * Ctrl/Cmd-K palette: navigation + recent requests. Full-text search lives
 * on the Search page; the palette jumps, it does not query the backend.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const rows = useLive((s) => s.rows);
  const recent = useMemo(() => rows.slice(0, 12), [rows]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (to: string): void => {
    setOpen(false);
    navigate(to);
  };

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal pattern
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop click propagation */}
      <div onClick={(e) => e.stopPropagation()} role="presentation" className="w-full max-w-xl">
        <Command
          label="Command palette"
          className="overflow-hidden rounded-lg border border-line bg-overlay shadow-2xl"
        >
          <Command.Input
            autoFocus
            placeholder="jump to…"
            className="h-11 w-full border-b border-line bg-transparent px-4 text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
          <Command.List className="max-h-[50vh] overflow-y-auto p-1.5 text-[13px]">
            <Command.Empty className="px-3 py-6 text-center text-ink-faint">
              nothing matches
            </Command.Empty>

            <Command.Group
              heading="Pages"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-ink-faint"
            >
              {(
                [
                  ['Overview', '/', Activity],
                  ['Live Monitor', '/live', Radio],
                  ['Sessions', '/sessions', Layers],
                  ['Search', '/search', SearchIcon],
                  ['Analytics', '/analytics', BarChart3],
                  ['Storage', '/storage', Database],
                ] as const
              ).map(([label, to, Icon]) => (
                <Command.Item
                  key={to}
                  value={`page ${label}`}
                  onSelect={() => go(to)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-ink-dim data-[selected=true]:bg-raised data-[selected=true]:text-ink"
                >
                  <Icon className="size-4" />
                  {label}
                </Command.Item>
              ))}
            </Command.Group>

            {recent.length > 0 ? (
              <Command.Group
                heading="Recent requests"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-ink-faint"
              >
                {recent.map((r) => (
                  <Command.Item
                    key={r.requestId}
                    value={`req ${r.requestId} ${r.model ?? ''} ${r.adapterId}`}
                    onSelect={() => go(`/requests/${r.requestId}`)}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 data-[selected=true]:bg-raised"
                  >
                    <span className="font-mono text-[11px] text-ink-faint">{fmtTime(r.ts)}</span>
                    <StatusPill status={r.status} />
                    <span className="truncate font-mono text-[12px]">{r.model ?? r.endpoint}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-faint">
                      {shortId(r.requestId)}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
          <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10.5px] text-ink-faint">
            <span>↑↓ navigate</span>
            <span>⏎ open</span>
            <span>esc close</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
