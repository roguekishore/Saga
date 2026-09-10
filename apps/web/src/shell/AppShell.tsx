import { Badge, cn, fmtBytes, Tip, TooltipProvider } from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bot,
  Database,
  FileClock,
  Layers,
  Moon,
  Radio,
  ScrollText,
  Search,
  Settings,
  Sun,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { CommandPalette } from '../components/CommandPalette';
import { api } from '../lib/api';
import { useLive } from '../lib/live-store';
import { useLiveSocket } from '../lib/ws';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  phase?: string;
}

const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Observe',
    items: [
      { to: '/', label: 'Overview', icon: Activity },
      { to: '/live', label: 'Live Monitor', icon: Radio },
    ],
  },
  {
    group: 'Explore',
    items: [
      { to: '/sessions', label: 'Sessions', icon: Layers },
      { to: '/search', label: 'Search', icon: Search },
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
      { to: '/storage', label: 'Storage', icon: Database },
    ],
  },
  {
    group: 'Devtools',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot },
      { to: '/tools', label: 'Tools', icon: Wrench },
      { to: '/diff', label: 'Prompt Diff', icon: ArrowLeftRight },
      { to: '/waterfall', label: 'Waterfall', icon: FileClock },
    ],
  },
  {
    group: 'Platform',
    items: [
      { to: '/sql', label: 'SQL Explorer', icon: TerminalSquare },
      { to: '/logs', label: 'Logs', icon: ScrollText },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = (): void => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('saga-theme', next ? 'dark' : 'light');
  };
  return [dark, toggle];
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, 'Overview'],
  [/^\/live/, 'Live Request Monitor'],
  [/^\/requests\/.+\/context/, 'Context Breakdown'],
  [/^\/requests\//, 'Prompt Inspector'],
  [/^\/sessions\/.+/, 'Session'],
  [/^\/sessions/, 'Session Explorer'],
  [/^\/search/, 'Search Center'],
  [/^\/analytics/, 'Analytics'],
  [/^\/storage/, 'Storage'],
  [/^\/agents/, 'Agent Explorer'],
  [/^\/tools/, 'Tool Explorer'],
  [/^\/diff/, 'Prompt Diff'],
  [/^\/waterfall/, 'Request Waterfall'],
  [/^\/sql/, 'SQL Explorer'],
  [/^\/logs/, 'Logs Explorer'],
  [/^\/settings/, 'Settings'],
];

export function AppShell() {
  useLiveSocket();
  const location = useLocation();
  const [dark, toggleTheme] = useTheme();
  const connected = useLive((s) => s.connected);
  const metrics = useLive((s) => s.metrics);
  const captureErrors = useLive((s) => s.captureErrors);

  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 10_000 });

  useEffect(() => {
    const title = TITLES.find(([re]) => re.test(location.pathname))?.[1];
    document.title = title ? `${title} · SAGA` : 'SAGA';
  }, [location.pathname]);

  const dropped = metrics?.queue.dropped ?? health.data?.queue.dropped ?? 0;

  return (
    <TooltipProvider>
      <CommandPalette />
      <div className="flex h-full">
        {/* ---------------------------------------------------- sidebar */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
          <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
            <div className="flex size-7 items-center justify-center rounded-md bg-accent font-bold text-accent-ink">
              S
            </div>
            <div>
              <div className="text-[14px] font-bold leading-4 tracking-tight">SAGA</div>
              <div className="text-[10px] text-ink-faint">gateway observability</div>
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-2">
            {NAV.map((group) => (
              <div key={group.group} className="mt-3">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  {group.group}
                </div>
                {group.items.map((item) =>
                  item.phase ? (
                    <Tip
                      key={item.to}
                      content={`Ships in ${item.phase} — the contract is frozen, the page is not built yet.`}
                      side="right"
                    >
                      <div className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] text-ink-faint/70">
                        <item.icon className="size-4" />
                        {item.label}
                        <Badge className="ml-auto opacity-70">{item.phase}</Badge>
                      </div>
                    </Tip>
                  ) : (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium',
                          isActive
                            ? 'bg-raised text-ink'
                            : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
                        )
                      }
                    >
                      <item.icon className="size-4" />
                      {item.label}
                    </NavLink>
                  ),
                )}
              </div>
            ))}
          </nav>
          <div className="border-t border-line px-4 py-2.5 text-[10.5px] leading-4 text-ink-faint">
            loopback only · no auth
            <br />
            do not port-forward
          </div>
        </aside>

        {/* ------------------------------------------------------ main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
            <div className="text-[13px] font-semibold tracking-tight">
              {TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? 'SAGA'}
            </div>
            <div className="flex items-center gap-2">
              {captureErrors > 0 ? (
                <Tip content="Capture-side errors occurred. The forward path is unaffected by design — but some requests may be recorded incompletely.">
                  <span>
                    <Badge tone="warn">{captureErrors} capture err</Badge>
                  </span>
                </Tip>
              ) : null}
              {dropped > 0 ? (
                <Tip content="The bounded capture queue shed its oldest events under pressure. Clients were never blocked; this counter is the cost.">
                  <span>
                    <Badge tone="warn">{dropped} dropped</Badge>
                  </span>
                </Tip>
              ) : null}
              <Tip
                content={
                  connected
                    ? 'Live event stream connected.'
                    : 'Event stream disconnected — is the collector running? (pnpm dev:collector)'
                }
              >
                <span
                  className={cn(
                    'inline-flex cursor-default items-center gap-1.5 text-[11.5px] font-medium',
                    connected ? 'text-ok' : 'text-err',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      connected ? 'bg-ok animate-pulse' : 'bg-err',
                    )}
                  />
                  {connected ? 'live' : 'offline'}
                </span>
              </Tip>
              <button
                type="button"
                onClick={toggleTheme}
                className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-dim hover:bg-raised hover:text-ink"
                aria-label="toggle theme"
              >
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </button>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>

          <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface px-4 text-[10.5px] text-ink-faint">
            {health.data ? (
              <>
                <span className="font-mono">
                  proxy :{health.data.proxy.port} → {health.data.proxy.upstream}
                </span>
                <span>db {fmtBytes(health.data.db.sizeBytes)}</span>
                <span>
                  queue {metrics?.queue.depth ?? health.data.queue.depth}/
                  {health.data.queue.capacity}
                </span>
                <span className="ml-auto">saga {health.data.version}</span>
              </>
            ) : (
              <span className="text-err">
                collector unreachable — start it with `pnpm dev:collector`
              </span>
            )}
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}
