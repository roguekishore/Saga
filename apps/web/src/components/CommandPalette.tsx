import { fmtTime, Kbd, StatusPill, shortId, springPop } from '@saga/ui';
import { Command } from 'cmdk';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bot,
  Database,
  FileClock,
  Layers,
  Radio,
  ScrollText,
  Search as SearchIcon,
  Settings,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useLive } from '../lib/live-store';

/**
 * Ctrl/Cmd-K palette: navigation + recent requests. Full-text search lives
 * on the Search page; the palette jumps, it does not query the backend.
 */

const PAGES = [
  ['Overview', '/', Activity],
  ['Live Monitor', '/live', Radio],
  ['Sessions', '/sessions', Layers],
  ['Search', '/search', SearchIcon],
  ['Analytics', '/analytics', BarChart3],
  ['Storage', '/storage', Database],
  ['Agents', '/agents', Bot],
  ['Tools', '/tools', Wrench],
  ['Prompt Diff', '/diff', ArrowLeftRight],
  ['Waterfall', '/waterfall', FileClock],
  ['SQL Explorer', '/sql', TerminalSquare],
  ['Logs', '/logs', ScrollText],
  ['Settings', '/settings', Settings],
] as const;

const GROUP_CLS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-ink-faint';

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const rows = useLive((s) => s.rows);
  const recent = useMemo(() => rows.slice(0, 9), [rows]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const go = (to: string): void => {
    onOpenChange(false);
    navigate(to);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-[2px]"
          onClick={() => onOpenChange(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onOpenChange(false);
          }}
          role="presentation"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4, transition: { duration: 0.1 } }}
            transition={springPop}
            onClick={(e) => e.stopPropagation()}
            role="presentation"
            className="w-full max-w-xl px-4"
          >
            <Command
              label="Command palette"
              className="overflow-hidden rounded-[14px] border border-line bg-overlay shadow-float"
            >
              <div className="flex items-center gap-2.5 border-b border-line px-4">
                <SearchIcon className="size-4 shrink-0 text-ink-faint" />
                <Command.Input
                  autoFocus
                  placeholder="jump to a page or request…"
                  className="h-11 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>
              <Command.List className="max-h-[46vh] overflow-y-auto p-1.5 text-[13px]">
                <Command.Empty className="px-3 py-8 text-center text-[12px] text-ink-faint">
                  nothing matches
                </Command.Empty>

                <Command.Group heading="Pages" className={GROUP_CLS}>
                  {PAGES.map(([label, to, Icon]) => (
                    <Command.Item
                      key={to}
                      value={`page ${label}`}
                      onSelect={() => go(to)}
                      className="group relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-ink-dim data-[selected=true]:bg-raised data-[selected=true]:text-ink"
                    >
                      <span className="absolute inset-y-1.5 left-0 hidden w-[2px] rounded-full bg-accent group-data-[selected=true]:block" />
                      <Icon className="size-4 text-ink-faint group-data-[selected=true]:text-accent" />
                      {label}
                    </Command.Item>
                  ))}
                </Command.Group>

                {recent.length > 0 ? (
                  <Command.Group heading="Recent requests" className={GROUP_CLS}>
                    {recent.map((r) => (
                      <Command.Item
                        key={r.requestId}
                        value={`req ${r.requestId} ${r.model ?? ''} ${r.adapterId}`}
                        onSelect={() => go(`/requests/${r.requestId}`)}
                        className="group relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 data-[selected=true]:bg-raised"
                      >
                        <span className="absolute inset-y-1.5 left-0 hidden w-[2px] rounded-full bg-accent group-data-[selected=true]:block" />
                        <span className="font-mono text-[11px] text-ink-faint">
                          {fmtTime(r.ts)}
                        </span>
                        <StatusPill status={r.status} />
                        <span className="truncate font-mono text-[12px]">
                          {r.model ?? r.endpoint}
                        </span>
                        <span className="ml-auto font-mono text-[11px] text-ink-faint">
                          {shortId(r.requestId)}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null}
              </Command.List>
              <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10.5px] text-ink-faint">
                <span className="inline-flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> navigate
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>⏎</Kbd> open
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>esc</Kbd> close
                </span>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
