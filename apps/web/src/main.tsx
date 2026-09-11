import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './shell/AppShell';
import { RouteError } from './shell/RouteError';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';

/**
 * Every page is its own chunk. The shell paints immediately; page code
 * arrives on navigation. Heavy vendors (charts, graph, 3d) are split further
 * in vite.config so no route drags a renderer it does not use.
 */
const page = <T,>(load: () => Promise<T>, pick: (m: T) => React.ComponentType) =>
  lazy(() => load().then((m) => ({ default: pick(m) })));

const OverviewPage = page(
  () => import('./pages/OverviewPage'),
  (m) => m.OverviewPage,
);
const LiveMonitorPage = page(
  () => import('./pages/LiveMonitorPage'),
  (m) => m.LiveMonitorPage,
);
const RequestInspectorPage = page(
  () => import('./pages/RequestInspectorPage'),
  (m) => m.RequestInspectorPage,
);
const ContextBreakdownPage = page(
  () => import('./pages/ContextBreakdownPage'),
  (m) => m.ContextBreakdownPage,
);
const SessionsPage = page(
  () => import('./pages/SessionsPage'),
  (m) => m.SessionsPage,
);
const SessionDetailPage = page(
  () => import('./pages/SessionDetailPage'),
  (m) => m.SessionDetailPage,
);
const SearchPage = page(
  () => import('./pages/SearchPage'),
  (m) => m.SearchPage,
);
const AnalyticsPage = page(
  () => import('./pages/AnalyticsPage'),
  (m) => m.AnalyticsPage,
);
const StoragePage = page(
  () => import('./pages/StoragePage'),
  (m) => m.StoragePage,
);
const AgentsPage = page(
  () => import('./pages/AgentsPage'),
  (m) => m.AgentsPage,
);
const ToolsPage = page(
  () => import('./pages/ToolsPage'),
  (m) => m.ToolsPage,
);
const DiffPage = page(
  () => import('./pages/DiffPage'),
  (m) => m.DiffPage,
);
const WaterfallPage = page(
  () => import('./pages/WaterfallPage'),
  (m) => m.WaterfallPage,
);
const SqlPage = page(
  () => import('./pages/SqlPage'),
  (m) => m.SqlPage,
);
const LogsPage = page(
  () => import('./pages/LogsPage'),
  (m) => m.LogsPage,
);
const SettingsPage = page(
  () => import('./pages/SettingsPage'),
  (m) => m.SettingsPage,
);
const NotFoundPage = page(
  () => import('./pages/NotFoundPage'),
  (m) => m.NotFoundPage,
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 3_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
    // Shell-level catch: failures in the shell itself land here.
    errorElement: <RouteError />,
    children: [
      {
        // Pathless boundary: a page crash renders the error surface inside
        // the shell, so navigation stays alive instead of the app blanking.
        errorElement: <RouteError />,
        children: [
          { path: '/', element: <OverviewPage /> },
          { path: '/live', element: <LiveMonitorPage /> },
          { path: '/requests/:id', element: <RequestInspectorPage /> },
          { path: '/requests/:id/context', element: <ContextBreakdownPage /> },
          { path: '/sessions', element: <SessionsPage /> },
          { path: '/sessions/:id', element: <SessionDetailPage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/analytics', element: <AnalyticsPage /> },
          { path: '/storage', element: <StoragePage /> },
          { path: '/agents', element: <AgentsPage /> },
          { path: '/tools', element: <ToolsPage /> },
          { path: '/diff', element: <DiffPage /> },
          { path: '/waterfall', element: <WaterfallPage /> },
          { path: '/sql', element: <SqlPage /> },
          { path: '/logs', element: <LogsPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
