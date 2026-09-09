import { z } from 'zod';
import { RequestStatusSchema } from './events';
import { NormalizedMessageSchema, NormalizedRequestSchema } from './messages';
import { AggUsageSchema, UsageSchema, UsageValueSchema } from './provenance';

/**
 * `ReadAPI` — the frozen shape the dashboard codes against. Served on
 * 127.0.0.1:8788 (loopback only; there is no auth — loopback IS the boundary).
 *
 * Frozen at p0-contracts. Additive changes only; breaking changes are W0-owned
 * and announced at a phase gate.
 */

// ---------------------------------------------------------------- health

export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  now: z.number(),
  uptimeMs: z.number(),
  proxy: z.object({ host: z.string(), port: z.number(), upstream: z.string() }),
  queue: z.object({
    depth: z.number().int(),
    capacity: z.number().int(),
    /** Drop-oldest counter. Nonzero means capture shed load; clients were unaffected. */
    dropped: z.number().int(),
  }),
  db: z.object({ path: z.string(), sizeBytes: z.number().int(), walBytes: z.number().int() }),
  wsClients: z.number().int(),
});
export type Health = z.infer<typeof HealthSchema>;

// ---------------------------------------------------------------- overview

export const SparkPointSchema = z.object({ t: z.number(), v: z.number() });

export const OverviewSchema = z.object({
  activeRequests: z.number().int(),
  activeSessions: z.number().int(),
  requestsToday: z.number().int(),
  tokensToday: z.object({ input: AggUsageSchema, output: AggUsageSchema }),
  avgLatencyMs: z.number().nullable(),
  p95LatencyMs: z.number().nullable(),
  errorRateToday: z.number().nullable(),
  /**
   * Null when no adapter in play produces cache fields (true for kiro) —
   * renders as "n/a", never 0.
   */
  cacheHitRatio: z.number().nullable(),
  /**
   * Null unless a price table applies to the adapter. Subscription upstreams
   * are null by definition — per-token cost math against them is fiction.
   */
  costToday: z.object({ value: z.number(), currency: z.string(), basis: z.string() }).nullable(),
  requestsSparkline: z.array(SparkPointSchema),
  outputTokensSparkline: z.array(SparkPointSchema),
  topModels: z.array(
    z.object({ model: z.string(), requests: z.number().int(), outputTokens: AggUsageSchema }),
  ),
  recentErrors: z.array(
    z.object({
      requestId: z.string(),
      ts: z.number(),
      model: z.string().nullable(),
      message: z.string(),
    }),
  ),
});
export type Overview = z.infer<typeof OverviewSchema>;

// ---------------------------------------------------------------- requests

export const RequestSummarySchema = z.object({
  requestId: z.string(),
  ts: z.number(),
  sessionId: z.string(),
  adapterId: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  endpoint: z.string(),
  stream: z.boolean(),
  status: RequestStatusSchema.nullable(), // null while in flight
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().nullable(),
  ttftMs: z.number().nullable(),
  inputTokens: UsageValueSchema.nullable(),
  outputTokens: UsageValueSchema.nullable(),
  messageCount: z.number().int(),
  toolUseCount: z.number().int(),
  /** P3 heuristic; null until correlated. Always inferred. */
  agentId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  redactionFlagged: z.boolean(),
});
export type RequestSummary = z.infer<typeof RequestSummarySchema>;

export const RequestListQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  /** Opaque cursor from a previous page. */
  cursor: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  model: z.string().optional(),
  adapterId: z.string().optional(),
  status: RequestStatusSchema.optional(),
  from: z.number().optional(),
  to: z.number().optional(),
});
export type RequestListQuery = z.infer<typeof RequestListQuerySchema>;

export const RequestListSchema = z.object({
  items: z.array(RequestSummarySchema),
  nextCursor: z.string().nullable(),
});
export type RequestList = z.infer<typeof RequestListSchema>;

export const RequestDetailSchema = z.object({
  summary: RequestSummarySchema,
  request: NormalizedRequestSchema,
  response: z.object({
    message: NormalizedMessageSchema.nullable(),
    stopReason: z.string().nullable(),
    usage: UsageSchema,
  }),
  timeline: z.object({
    sentAt: z.number(),
    firstTokenAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  }),
  redaction: z.object({
    hits: z.array(z.object({ kind: z.string(), count: z.number().int() })),
    flagged: z.boolean(),
  }),
  frameStats: z
    .object({ frames: z.number().int(), bytes: z.number().int(), parseErrors: z.number().int() })
    .nullable(),
});
export type RequestDetail = z.infer<typeof RequestDetailSchema>;

// ---------------------------------------------------------------- sessions

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  startedAt: z.number(),
  lastActivityAt: z.number(),
  /**
   * How this session's boundary was decided. `client-declared` means the client
   * stated its own session id on the wire — Claude Code does, on every
   * `/v1/messages` — and the boundary is evidence. `inferred` means SAGA
   * guessed it from client, workspace and idle time.
   */
  sessionIdSource: z.enum(['client-declared', 'inferred']).default('inferred'),
  /**
   * The client's own session id. For Claude Code this is the uuid naming
   * `~/.claude/projects/<slug>/<uuid>.jsonl`, which is what makes local
   * transcript enrichment possible. Null when nothing was stated.
   */
  clientSessionId: z.string().nullable().default(null),
  /**
   * True only when the boundary is a SAGA guess, so the UI tags exactly the
   * rows that deserve it. This was once `literal(true)` — correct while every
   * session was inferred, a lie the moment sessions could be wire-stated.
   */
  inferred: z.boolean(),
  clientName: z.string().nullable(),
  workspace: z.string().nullable(),
  /**
   * Read from the client's own local transcript, not the wire: the title
   * Claude Code gave the conversation, its working directory, its git branch.
   * Null until an enrichment pass has seen the session.
   */
  title: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  gitBranch: z.string().nullable().default(null),
  requests: z.number().int(),
  errors: z.number().int(),
  models: z.array(z.string()),
  inputTokens: AggUsageSchema,
  outputTokens: AggUsageSchema,
  totalLatencyMs: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionListSchema = z.object({
  items: z.array(SessionSummarySchema),
  nextCursor: z.string().nullable(),
});
export type SessionList = z.infer<typeof SessionListSchema>;

// ---------------------------------------------------------------- search

export const SearchHitSchema = z.object({
  messageId: z.number().int(),
  requestId: z.string(),
  sessionId: z.string(),
  ts: z.number(),
  role: z.string(),
  /** Server-computed from the decompressed body around the match. */
  snippet: z.string(),
});
export const SearchResultSchema = z.object({
  items: z.array(SearchHitSchema),
  totalMs: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---------------------------------------------------------------- analytics

export const TokenSeriesQuerySchema = z.object({
  from: z.number(),
  to: z.number(),
  bucket: z.enum(['hour', 'day']),
  groupBy: z.enum(['none', 'model', 'adapterId', 'agentId']).default('none'),
});
export const TokenSeriesSchema = z.object({
  series: z.array(
    z.object({
      t: z.number(),
      group: z.string().nullable(),
      input: AggUsageSchema,
      output: AggUsageSchema,
      requests: z.number().int(),
    }),
  ),
});
export type TokenSeries = z.infer<typeof TokenSeriesSchema>;

export const LatencySeriesSchema = z.object({
  series: z.array(
    z.object({
      t: z.number(),
      avg: z.number().nullable(),
      p50: z.number().nullable(),
      p95: z.number().nullable(),
      avgTtft: z.number().nullable(),
      count: z.number().int(),
    }),
  ),
  /** Downsampled raw points for scatter views. */
  sample: z.array(
    z.object({
      ts: z.number(),
      latencyMs: z.number(),
      ttftMs: z.number().nullable(),
      outputTokens: z.number().nullable(),
      model: z.string().nullable(),
      requestId: z.string(),
    }),
  ),
});
export type LatencySeries = z.infer<typeof LatencySeriesSchema>;

export const ContextGrowthSchema = z.object({
  sessionId: z.string(),
  points: z.array(
    z.object({
      requestId: z.string(),
      ts: z.number(),
      turn: z.number().int(),
      inputTokens: UsageValueSchema.nullable(),
      outputTokens: UsageValueSchema.nullable(),
      messageCount: z.number().int(),
      /** Redacted request bytes — an honest size signal with no estimation. */
      requestBytes: z.number().int(),
    }),
  ),
});
export type ContextGrowth = z.infer<typeof ContextGrowthSchema>;

// ---------------------------------------------------------------- storage

export const StorageInfoSchema = z.object({
  dbSizeBytes: z.number().int(),
  walSizeBytes: z.number().int(),
  requestCount: z.number().int(),
  messageCount: z.number().int(),
  sessionCount: z.number().int(),
  /** Bytes saved by SHA-256 dedup (sum of duplicate reference sizes). */
  dedupSavedBytes: z.number().int(),
  /** Uncompressed vs stored bytes over compressed bodies. */
  compression: z.object({ rawBytes: z.number().int(), storedBytes: z.number().int() }),
  tiers: z.array(
    z.object({ tier: z.enum(['hot', 'warm', 'cold', 'archive']), requests: z.number().int() }),
  ),
  largestSessions: z.array(
    z.object({ sessionId: z.string(), bytes: z.number().int(), requests: z.number().int() }),
  ),
  retention: z.object({
    hotDays: z.number(),
    warmDays: z.number(),
    coldDays: z.number(),
    lastCleanupAt: z.number().nullable(),
    lastVacuumAt: z.number().nullable(),
  }),
});
export type StorageInfo = z.infer<typeof StorageInfoSchema>;

// ---------------------------------------------------------------- agents (P3)

export const AgentSummarySchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  parentAgentId: z.string().nullable(),
  /** Correlation is heuristic (timing + prompt shape). Always inferred. */
  inferred: z.literal(true),
  label: z.string(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  requests: z.number().int(),
  outputTokens: AggUsageSchema,
  toolUseCount: z.number().int(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const ToolStatSchema = z.object({
  name: z.string(),
  calls: z.number().int(),
  /** From matching tool_result frames; null where results were not observed. */
  errors: z.number().int().nullable(),
  requestsUsedIn: z.number().int(),
});
export const ToolCallRowSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  agentId: z.string().nullable(),
  ts: z.number(),
  toolUseId: z.string(),
  name: z.string(),
  inputJson: z.string().nullable(),
  /** Observed only if the client sent the matching tool_result back. */
  resultObserved: z.boolean(),
  resultIsError: z.boolean().nullable(),
  /** Wall time between tool_use and the next request carrying its result — inferred. */
  roundTripMs: z.number().nullable(),
});
export type ToolCallRow = z.infer<typeof ToolCallRowSchema>;

// ---------------------------------------------------------------- sql (P4)

export const SqlRequestSchema = z.object({ sql: z.string().max(20_000) });
export const SqlResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  elapsedMs: z.number(),
});
export type SqlResult = z.infer<typeof SqlResultSchema>;

// ---------------------------------------------------------------- logs (P4)

export const LogLineSchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  scope: z.string(),
  message: z.string(),
});
export const LogPageSchema = z.object({
  items: z.array(LogLineSchema),
  nextAfter: z.number().int().nullable(),
});
export type LogPage = z.infer<typeof LogPageSchema>;

// ---------------------------------------------------------------- settings

export const SettingsSchema = z.object({
  proxy: z.object({
    host: z.string(),
    port: z.number().int(),
    upstream: z.string(),
  }),
  api: z.object({ host: z.string(), port: z.number().int() }),
  db: z.object({ path: z.string() }),
  capture: z.object({ queueCapacity: z.number().int(), rawSse: z.boolean() }),
  retention: z.object({ hotDays: z.number(), warmDays: z.number(), coldDays: z.number() }),
  /** Static truth for the Settings page: what protects the open endpoints. */
  securityNote: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------- route map

/** Path constants — one source of truth for server routes and client calls. */
export const API_PATHS = {
  health: '/api/health',
  overview: '/api/overview',
  requests: '/api/requests',
  requestById: (id: string) => `/api/requests/${encodeURIComponent(id)}`,
  sessions: '/api/sessions',
  sessionById: (id: string) => `/api/sessions/${encodeURIComponent(id)}`,
  search: '/api/search',
  analyticsTokens: '/api/analytics/tokens',
  analyticsLatency: '/api/analytics/latency',
  analyticsContextGrowth: '/api/analytics/context-growth',
  storage: '/api/storage',
  agents: '/api/agents',
  tools: '/api/tools',
  toolCalls: '/api/tools/calls',
  sql: '/api/sql',
  logs: '/api/logs',
  settings: '/api/settings',
  ws: '/ws',
} as const;
