import {
  AgentSummarySchema,
  API_PATHS,
  ContextGrowthSchema,
  HealthSchema,
  LatencySeriesSchema,
  OverviewSchema,
  RequestDetailSchema,
  RequestListSchema,
  SearchResultSchema,
  SessionListSchema,
  SettingsSchema,
  StorageInfoSchema,
  TokenSeriesSchema,
  ToolCallRowSchema,
  ToolStatSchema,
} from '@saga/contracts';
import { z } from 'zod';

/**
 * Typed client over the frozen ReadAPI. Every response is zod-parsed on the
 * way in — the dashboard cannot silently drift from the contract it codes
 * against, and neither can the server.
 */

async function get(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<unknown> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

export const api = {
  health: async () => HealthSchema.parse(await get(API_PATHS.health)),
  overview: async () => OverviewSchema.parse(await get(API_PATHS.overview)),
  requests: async (params: {
    limit?: number;
    cursor?: string;
    sessionId?: string;
    model?: string;
    adapterId?: string;
    status?: string;
    agentId?: string;
  }) => RequestListSchema.parse(await get(API_PATHS.requests, params)),
  requestDetail: async (id: string) =>
    RequestDetailSchema.parse(await get(API_PATHS.requestById(id))),
  sessions: async (params: { limit?: number; cursor?: string } = {}) =>
    SessionListSchema.parse(await get(API_PATHS.sessions, params)),
  search: async (q: string, limit = 25) =>
    SearchResultSchema.parse(await get(API_PATHS.search, { q, limit })),
  tokenSeries: async (params: {
    from: number;
    to: number;
    bucket: 'hour' | 'day';
    groupBy?: string;
  }) => TokenSeriesSchema.parse(await get(API_PATHS.analyticsTokens, params)),
  latencySeries: async (params: { from: number; to: number; bucket: 'hour' | 'day' }) =>
    LatencySeriesSchema.parse(await get(API_PATHS.analyticsLatency, params)),
  contextGrowth: async (sessionId: string) =>
    ContextGrowthSchema.parse(await get(API_PATHS.analyticsContextGrowth, { sessionId })),
  storage: async () => StorageInfoSchema.parse(await get(API_PATHS.storage)),
  settings: async () => SettingsSchema.parse(await get(API_PATHS.settings)),
  agents: async (sessionId?: string) =>
    z.array(AgentSummarySchema).parse(await get(API_PATHS.agents, { sessionId })),
  toolStats: async () => z.array(ToolStatSchema).parse(await get(API_PATHS.tools)),
  toolCalls: async (params: {
    name?: string;
    sessionId?: string;
    requestId?: string;
    limit?: number;
  }) => z.array(ToolCallRowSchema).parse(await get(API_PATHS.toolCalls, params)),
};
