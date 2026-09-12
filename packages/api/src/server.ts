import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { AnalyticsBackend } from '@saga/analytics';
import {
  API_PATHS,
  type Logger,
  type NormalizedEvent,
  noopLogger,
  RequestListQuerySchema,
  type Settings,
  type WsServerMessage,
} from '@saga/contracts';
import type { Driver } from '@saga/store';
import { Hono } from 'hono';
import { listAgents, listToolCalls, listToolStats } from './devtools-queries';
import { getTurnDetail, listSessionTurns } from './hierarchy';
import { DEFAULT_MAX_INGEST_BYTES, handleConduitIngest } from './ingest';
import {
  getOverview,
  getRequestDetail,
  getSession,
  getStorageInfo,
  listRequests,
  listSessions,
  searchMessages,
} from './queries';
import { SqlExecutor } from './sql';

/**
 * The read API + WebSocket fan-out on 127.0.0.1:8788. There is NO auth:
 * explicit loopback binding is the security boundary, stated here, in the
 * README, and on the Settings page. REST serves state; the socket serves
 * deltas only.
 */

export interface EventSource {
  subscribe(fn: (ev: NormalizedEvent) => void): () => void;
  stats(): { depth: number; capacity: number; dropped: number };
}

export interface ProxyInfo {
  host: string;
  port: number;
  upstream: string;
  activeRequests(): number;
}

export interface ApiServerOptions {
  host?: string;
  port: number;
  db: Driver;
  dbPath: string;
  analytics: AnalyticsBackend;
  events: EventSource;
  proxy: ProxyInfo;
  version: string;
  retention?: { hotDays: number; warmDays: number; coldDays: number };
  metricsIntervalMs?: number;
  logger?: Logger;
  settings?: Partial<Settings>;
  /** SAGA's own log lines (P4 Logs Explorer). */
  logLines?: (
    afterSeq: number,
    limit: number,
  ) => Array<{
    seq: number;
    ts: number;
    level: 'debug' | 'info' | 'warn' | 'error';
    scope: string;
    message: string;
  }>;
  /** Serve the built dashboard from this directory (SPA fallback). */
  staticDir?: string;
  /**
   * Push an event onto the capture queue. Required by the CONDUIT ingest seam:
   * that endpoint must NOT write to SQLite — `StoreWriter` is the single writer —
   * so it validates, redacts, and enqueues. That is also what makes the
   * contract's fire-and-forget guarantee free rather than something the handler
   * has to arrange.
   *
   * Optional so existing read-only callers (tests, the desktop shell) construct
   * unchanged; without it the ingest route reports itself unavailable instead of
   * silently accepting and dropping CONDUIT's data.
   */
  emit?: (ev: NormalizedEvent) => void;
  /** Cap on the ingest body. See `ingest.ts` for why this is not a formality. */
  maxIngestBytes?: number;
}

export interface ApiServerHandle {
  port: number;
  host: string;
  wsClients(): number;
  stop(): void;
}

const MAX_WS_BUFFER = 4 * 1024 * 1024;

export function startApiServer(opts: ApiServerOptions): ApiServerHandle {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.logger ?? noopLogger;
  const retention = opts.retention ?? { hotDays: 30, warmDays: 90, coldDays: 180 };
  const startedAt = Date.now();
  const app = new Hono();

  const num = (v: string | undefined): number | undefined => (v == null ? undefined : Number(v));

  app.get(API_PATHS.health, (c) => {
    const q = opts.events.stats();
    const pageCount = Number(opts.db.pragma('page_count') ?? 0);
    const pageSize = Number(opts.db.pragma('page_size') ?? 0);
    return c.json({
      ok: true,
      version: opts.version,
      now: Date.now(),
      uptimeMs: Date.now() - startedAt,
      proxy: { host: opts.proxy.host, port: opts.proxy.port, upstream: opts.proxy.upstream },
      queue: { depth: q.depth, capacity: q.capacity, dropped: q.dropped },
      db: { path: opts.dbPath, sizeBytes: pageCount * pageSize, walBytes: 0 },
      wsClients: sockets.size,
    });
  });

  app.get(API_PATHS.overview, (c) => c.json(getOverview(opts.db, Date.now())));

  app.get(API_PATHS.requests, (c) => {
    const parsed = RequestListQuerySchema.safeParse({
      limit: num(c.req.query('limit')) ?? 100,
      cursor: c.req.query('cursor'),
      sessionId: c.req.query('sessionId'),
      agentId: c.req.query('agentId'),
      model: c.req.query('model'),
      adapterId: c.req.query('adapterId'),
      status: c.req.query('status'),
      from: num(c.req.query('from')),
      to: num(c.req.query('to')),
    });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(listRequests(opts.db, parsed.data));
  });

  app.get('/api/requests/:id', (c) => {
    const detail = getRequestDetail(opts.db, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });

  app.get(API_PATHS.sessions, (c) => {
    const limit = Math.min(200, num(c.req.query('limit')) ?? 50);
    return c.json(listSessions(opts.db, limit, c.req.query('cursor')));
  });

  app.get('/api/sessions/:id', (c) => {
    const s = getSession(opts.db, c.req.param('id'));
    return s ? c.json(s) : c.json({ error: 'not found' }, 404);
  });

  app.get(API_PATHS.search, (c) => {
    const q = c.req.query('q') ?? '';
    const limit = Math.min(100, num(c.req.query('limit')) ?? 25);
    return c.json(searchMessages(opts.db, q, limit));
  });

  app.get(API_PATHS.analyticsTokens, (c) => {
    const from = num(c.req.query('from')) ?? Date.now() - 7 * 86_400_000;
    const to = num(c.req.query('to')) ?? Date.now();
    const bucket = c.req.query('bucket') === 'day' ? 'day' : 'hour';
    const g = c.req.query('groupBy');
    const groupBy = g === 'model' || g === 'adapterId' || g === 'agentId' ? g : ('none' as const);
    return c.json(opts.analytics.tokenSeries({ from, to, bucket, groupBy }));
  });

  app.get(API_PATHS.analyticsLatency, (c) => {
    const from = num(c.req.query('from')) ?? Date.now() - 7 * 86_400_000;
    const to = num(c.req.query('to')) ?? Date.now();
    const bucket = c.req.query('bucket') === 'day' ? 'day' : 'hour';
    return c.json(opts.analytics.latencySeries({ from, to, bucket }));
  });

  app.get(API_PATHS.analyticsContextGrowth, (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
    return c.json(opts.analytics.contextGrowth(sessionId));
  });

  // Storage info walks a tier histogram + 7d session grouping — ~285ms
  // uncached on the year-scale bench corpus. It feeds a 15s dashboard poll,
  // so a 20s TTL cache makes the effective cost ~0 while staying fresh.
  let storageCache: { at: number; value: unknown } | null = null;
  app.get(API_PATHS.storage, (c) => {
    if (!storageCache || Date.now() - storageCache.at > 20_000) {
      storageCache = { at: Date.now(), value: getStorageInfo(opts.db, opts.dbPath, retention) };
    }
    return c.json(storageCache.value);
  });

  // ---- WS-C: the hierarchy read path (C5 fills the queries behind these).
  app.get('/api/sessions/:id/turns', (c) => {
    const limit = Math.min(500, num(c.req.query('limit')) ?? 100);
    return c.json(
      listSessionTurns(opts.db, c.req.param('id'), { limit, cursor: c.req.query('cursor') }),
    );
  });

  app.get('/api/turns/:id', (c) => {
    const detail = getTurnDetail(opts.db, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });

  /**
   * ---- WS-C: the CONDUIT ingest seam. The FIRST WRITE endpoint on this server.
   *
   * Security posture, stated rather than buried: there is no auth here, exactly
   * as on the read API, WebSocket, and SQL endpoint. Loopback binding is the only
   * boundary. The body is treated as untrusted input even though the caller is a
   * local component — validated against the frozen schema and capped.
   *
   * The path is deliberately OUTSIDE `/api` (the seam contract froze it), which
   * is why the static handler below has to be taught to leave it alone; a bare
   * `!startsWith('/api')` would hand CONDUIT the SPA's index.html and a 200.
   */
  app.post(API_PATHS.ingestConduit, async (c) => {
    // Read as text first: the byte length is what the cap is about, and parsing
    // an oversized body to discover its size defeats the cap.
    let raw: string;
    try {
      raw = await c.req.text();
    } catch {
      return c.json({ error: 'could not read request body' }, 400);
    }
    const byteLength = Buffer.byteLength(raw, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: 'body must be JSON' }, 400);
    }
    if (!opts.emit) {
      return c.json({ error: 'saga ingest unavailable: no event sink configured' }, 503);
    }
    const r = handleConduitIngest(
      {
        emit: opts.emit,
        logger: log,
        maxBodyBytes: opts.maxIngestBytes ?? DEFAULT_MAX_INGEST_BYTES,
      },
      parsed,
      byteLength,
    );
    return c.json(r.body as Record<string, unknown>, r.status as 200);
  });

  app.get(API_PATHS.agents, (c) => c.json(listAgents(opts.db, c.req.query('sessionId'))));

  app.get(API_PATHS.tools, (c) => c.json(listToolStats(opts.db)));

  app.get(API_PATHS.toolCalls, (c) =>
    c.json(
      listToolCalls(opts.db, {
        name: c.req.query('name'),
        sessionId: c.req.query('sessionId'),
        requestId: c.req.query('requestId'),
        limit: Math.min(500, num(c.req.query('limit')) ?? 100),
      }),
    ),
  );

  app.get(API_PATHS.settings, (c) => {
    const s: Settings = {
      proxy: { host: opts.proxy.host, port: opts.proxy.port, upstream: opts.proxy.upstream },
      api: { host, port: opts.port },
      db: { path: opts.dbPath },
      capture: {
        queueCapacity: opts.events.stats().capacity,
        rawSse: false,
      },
      retention,
      securityNote:
        'SAGA binds loopback (127.0.0.1) explicitly. The read API, WebSocket, and SQL endpoint have no authentication — loopback isolation is the only boundary. Do not port-forward them.',
      ...opts.settings,
    };
    return c.json(s);
  });

  // ---- P4: read-only SQL endpoint (its own worker + readonly connection)
  const sqlExec = new SqlExecutor(opts.dbPath);
  app.post(API_PATHS.sql, async (c) => {
    let body: { sql?: string };
    try {
      body = (await c.req.json()) as { sql?: string };
    } catch {
      return c.json({ error: 'body must be JSON: {"sql": "SELECT …"}' }, 400);
    }
    if (typeof body.sql !== 'string' || body.sql.length > 20_000) {
      return c.json({ error: 'sql must be a string under 20k chars' }, 400);
    }
    const r = await sqlExec.run(body.sql);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json(r.result);
  });

  // ---- P4: SAGA's own logs
  app.get(API_PATHS.logs, (c) => {
    const after = num(c.req.query('after')) ?? -1;
    const limit = Math.min(1000, num(c.req.query('limit')) ?? 300);
    const items = opts.logLines?.(after, limit) ?? [];
    return c.json({
      items,
      nextAfter: items.length > 0 ? items[items.length - 1]!.seq : null,
    });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  // ---- static dashboard (desktop shell + headless browser use)
  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? opts.staticDir : null;
  async function serveStatic(pathname: string): Promise<Response | null> {
    if (!staticDir) return null;
    const rel = normalize(pathname).replaceAll('..', '');
    let file = Bun.file(join(staticDir, rel === '/' ? 'index.html' : rel));
    if (!(await file.exists())) {
      // SPA fallback: client-side routes resolve to index.html
      if (pathname.startsWith('/api/')) return null;
      file = Bun.file(join(staticDir, 'index.html'));
      if (!(await file.exists())) return null;
    }
    return new Response(file);
  }

  // ---- WebSocket fan-out
  type WsData = { id: number };
  const sockets = new Set<Bun.ServerWebSocket<WsData>>();
  let wsSeq = 0;

  const send = (ws: Bun.ServerWebSocket<WsData>, msg: WsServerMessage): void => {
    try {
      if (ws.getBufferedAmount() > MAX_WS_BUFFER) {
        // Slow consumer: shed it rather than buffer unboundedly.
        ws.close(1013, 'saga: consumer too slow');
        return;
      }
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log.log('warn', 'api', `ws send failed: ${String(err)}`);
    }
  };

  const broadcast = (msg: WsServerMessage): void => {
    for (const ws of sockets) send(ws, msg);
  };

  const unsubscribe = opts.events.subscribe((event) => {
    if (sockets.size > 0) broadcast({ type: 'event', event });
  });

  const metricsTimer = setInterval(() => {
    if (sockets.size === 0) return;
    const q = opts.events.stats();
    broadcast({
      type: 'metrics',
      ts: Date.now(),
      queue: { depth: q.depth, capacity: q.capacity, dropped: q.dropped },
      activeRequests: opts.proxy.activeRequests(),
      wsClients: sockets.size,
    });
  }, opts.metricsIntervalMs ?? 2000);

  const server = Bun.serve<WsData, never>({
    hostname: host,
    port: opts.port,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === API_PATHS.ws) {
        const ok = srv.upgrade(req, { data: { id: wsSeq++ } });
        return ok ? undefined : new Response('upgrade failed', { status: 400 });
      }
      // The static handler must not shadow a real route. `/ingest/conduit` sits
      // outside `/api` because the seam contract froze it there, so an
      // `/api`-only check would send CONDUIT's POST to the SPA fallback — which
      // answers with index.html and a 200, i.e. SAGA silently accepting and
      // discarding every emit. Non-GET requests are excluded too: the static
      // handler only ever serves documents, and letting a POST reach it is how
      // that class of bug appears in the first place.
      const isApiRoute =
        url.pathname.startsWith('/api') || url.pathname === API_PATHS.ingestConduit;
      if (!isApiRoute && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = await serveStatic(url.pathname);
        if (file) return file;
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        send(ws, { type: 'hello', serverVersion: opts.version, now: Date.now() });
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {
        // Read-only stream; client messages are ignored by design.
      },
    },
  });

  log.log('info', 'api', `read API on http://${host}:${server.port} (ws: ${API_PATHS.ws})`);

  return {
    port: server.port ?? opts.port,
    host,
    wsClients: () => sockets.size,
    stop: () => {
      clearInterval(metricsTimer);
      unsubscribe();
      sqlExec.dispose();
      server.stop(true);
    },
  };
}
