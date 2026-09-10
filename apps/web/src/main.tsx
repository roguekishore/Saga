import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AgentsPage } from './pages/AgentsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ContextBreakdownPage } from './pages/ContextBreakdownPage';
import { DiffPage } from './pages/DiffPage';
import { LiveMonitorPage } from './pages/LiveMonitorPage';
import { LogsPage } from './pages/LogsPage';
import { OverviewPage } from './pages/OverviewPage';
import { RequestInspectorPage } from './pages/RequestInspectorPage';
import { SearchPage } from './pages/SearchPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SqlPage } from './pages/SqlPage';
import { StoragePage } from './pages/StoragePage';
import { ToolsPage } from './pages/ToolsPage';
import { WaterfallPage } from './pages/WaterfallPage';
import { AppShell } from './shell/AppShell';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 3_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
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
      { path: '*', element: <OverviewPage /> },
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
