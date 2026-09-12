import { Badge, cn, fmtBytes, Kbd, Skeleton, springSnap, Tip, TooltipProvider } from '@saga/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bot,
  Database,
  FileClock,
  Layers,
  ListTree,
  Moon,
  Radio,
  ScrollText,
  Search,
  Settings,
  Sun,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { CommandPalette } from '../components/CommandPalette';
import { api } from '../lib/api';
import { useLive } from '../lib/live-store';
import { useLiveSocket } from '../lib/ws';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
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
      { to: '/hierarchy', label: 'Hierarchy', icon: ListTree },
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
  [/^\/live/, 'Live Monitor'],
  [/^\/requests\/.+\/context/, 'Context Breakdown'],
  [/^\/requests\//, 'Request Inspector'],
  [/^\/sessions\/.+/, 'Session'],
  [/^\/sessions/, 'Sessions'],
  [/^\/search/, 'Search'],
  [/^\/analytics/, 'Analytics'],
  [/^\/storage/, 'Storage'],
  [/^\/agents/, 'Agents'],
  [/^\/tools/, 'Tools'],
  [/^\/diff/, 'Prompt Diff'],
  [/^\/waterfall/, 'Waterfall'],
  [/^\/sql/, 'SQL Explorer'],
  [/^\/logs/, 'Logs'],
  [/^\/settings/, 'Settings'],
];

/** Route-chunk loading state: neutral shapes, no spinner theater. */
function PageFallback() {
  return (
    <div aria-busy className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {['a', 'b', 'c', 'd'].map((k) => (
          <Skeleton key={k} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

function SideNav() {
  return (
    <aside className="flex w-[216px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="flex size-7 items-center justify-center rounded-[8px] bg-accent font-bold text-[15px] text-accent-ink">
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
            <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              {group.group}
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5',
                    'text-[12.5px] font-medium transition-colors duration-(--dur-1)',
                    isActive
                      ? 'bg-raised text-ink'
                      : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <motion.span
                        layoutId="nav-rail"
                        transition={springSnap}
                        className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent"
                      />
                    ) : null}
                    <item.icon
                      className={cn(
                        'size-4 transition-colors duration-(--dur-1)',
                        isActive ? 'text-accent' : 'text-ink-faint group-hover:text-ink-dim',
                      )}
                    />
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t border-line px-4 py-2.5 text-[10.5px] leading-4 text-ink-faint">
        loopback only · no auth
        <br />
        do not port-forward
      </div>
    </aside>
  );
}

function LiveDot({ connected }: { connected: boolean }) {
  return (
    <Tip
      content={
        connected
          ? 'Live event stream connected.'
          : 'Event stream disconnected — is the collector running? (npm run dev:collector)'
      }
    >
      <span
        className={cn(
          'inline-flex cursor-default items-center gap-1.5 text-[11.5px] font-medium',
          connected ? 'text-ok' : 'text-err',
        )}
      >
        <span className="relative inline-flex size-1.5">
          {connected ? (
            <span className="absolute inset-0 animate-[saga-ping_1.8s_var(--ease-out)_infinite] rounded-full bg-ok motion-reduce:animate-none" />
          ) : null}
          <span
            className={cn(
              'relative inline-flex size-1.5 rounded-full',
              connected ? 'bg-ok' : 'bg-err',
            )}
          />
        </span>
        {connected ? 'live' : 'offline'}
      </span>
    </Tip>
  );
}

export function AppShell() {
  useLiveSocket();
  const location = useLocation();
  const [dark, toggleTheme] = useTheme();
  const connected = useLive((s) => s.connected);
  const metrics = useLive((s) => s.metrics);
  const captureErrors = useLive((s) => s.captureErrors);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 10_000 });

  const title = TITLES.find(([re]) => re.test(location.pathname))?.[1];
  useEffect(() => {
    document.title = title ? `${title} · SAGA` : 'SAGA';
  }, [title]);

  const dropped = metrics?.queue.dropped ?? health.data?.queue.dropped ?? 0;

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <div className="flex h-full">
          <SideNav />

          {/* ------------------------------------------------------ main */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
              <div className="text-[13px] font-semibold tracking-tight">{title ?? 'SAGA'}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  className={cn(
                    'hidden h-7 w-48 cursor-pointer items-center gap-2 rounded-md border border-line',
                    'bg-canvas/60 px-2.5 text-[11.5px] text-ink-faint transition-colors',
                    'duration-(--dur-1) hover:border-line-strong hover:text-ink-dim sm:flex',
                  )}
                >
                  <Search className="size-3.5" />
                  jump to…
                  <span className="ml-auto inline-flex items-center gap-0.5">
                    <Kbd>⌘</Kbd>
                    <Kbd>K</Kbd>
                  </span>
                </button>
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
                <LiveDot connected={connected} />
                <button
                  type="button"
                  onClick={toggleTheme}
                  aria-label="toggle theme"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-dim transition-colors duration-(--dur-1) hover:bg-raised hover:text-ink"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={dark ? 'sun' : 'moon'}
                      initial={{ opacity: 0, rotate: -40, scale: 0.7 }}
                      animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: 40, scale: 0.7 }}
                      transition={{ duration: 0.15 }}
                      className="flex"
                    >
                      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                    </motion.span>
                  </AnimatePresence>
                </button>
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto">
              <Suspense fallback={<PageFallback />}>
                <Outlet />
              </Suspense>
            </main>

            <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface px-4 font-mono text-[10.5px] text-ink-faint">
              {health.data ? (
                <>
                  <span>
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
                  collector unreachable — start it with `npm run dev:collector`
                </span>
              )}
            </footer>
          </div>
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}
