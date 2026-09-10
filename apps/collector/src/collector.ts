import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createAdapters } from '@saga/adapters';
import { SqliteAnalytics } from '@saga/analytics';
import { type ApiServerHandle, startApiServer } from '@saga/api';
import { BoundedEventQueue, type ProxyHandle, startProxy } from '@saga/capture';
import { scheduleEnrichment } from '@saga/enrich';
import {
  DEFAULT_RETENTION,
  type Driver,
  MIGRATIONS,
  openDatabase,
  runMigrations,
  StoreWriter,
  scheduleRetention,
  snapshotTo,
} from '@saga/store';
import { createRingLogger, type RingLogger } from './logger';

/**
 * Composition root: proxy → bounded queue → { store writer, WS fan-out },
 * plus the read API. One Bun process; Electron later spawns exactly this as
 * its sidecar, which is what keeps a future Tauri swap shell-only.
 */

export interface CollectorConfig {
  host: string;
  proxyPort: number;
  apiPort: number;
  upstream: string;
  dbPath: string;
  queueCapacity: number;
  /** Hosts that ARE the provider — usage from them is upstream-reported. */
  providerHosts?: string[];
  version?: string;
  /** Built dashboard directory to serve at / (desktop shell + headless). */
  uiDir?: string;
}

export const DEFAULT_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
];

export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): CollectorConfig {
  return {
    // Loopback EXPLICITLY. The reference upstream binds 0.0.0.0 and that is
    // a mistake, not a pattern: these ports have no auth.
    host: env.SAGA_HOST ?? '127.0.0.1',
    proxyPort: Number(env.SAGA_PROXY_PORT ?? 8787),
    apiPort: Number(env.SAGA_API_PORT ?? 8788),
    upstream: env.SAGA_UPSTREAM ?? 'http://127.0.0.1:8000',
    dbPath: env.SAGA_DB ?? resolve('storage', 'saga.db'),
    queueCapacity: Number(env.SAGA_QUEUE_CAP ?? 2048),
  };
}

export interface CollectorHandle {
  config: CollectorConfig;
  proxy: ProxyHandle;
  api: ApiServerHandle;
  db: Driver;
  writer: StoreWriter;
  queue: BoundedEventQueue;
  logger: RingLogger;
  snapshot(dest: string): void;
  stop(): void;
}

export function startCollector(cfg: CollectorConfig, logger?: RingLogger): CollectorHandle {
  const log = logger ?? createRingLogger();

  if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = openDatabase(cfg.dbPath);
  runMigrations(db, MIGRATIONS);

  const writer = new StoreWriter(db, log);
  const orphans = writer.reconcileInFlight();
  if (orphans > 0)
    log.log('info', 'store', `marked ${orphans} orphaned request(s) capture_incomplete`);

  const queue = new BoundedEventQueue(cfg.queueCapacity, log);
  queue.subscribe((ev) => writer.handleEvent(ev));

  const upstreamHost = new URL(cfg.upstream).hostname;
  const providerHosts = cfg.providerHosts ?? DEFAULT_PROVIDER_HOSTS;
  const usageSource = providerHosts.includes(upstreamHost)
    ? 'upstream-reported'
    : 'gateway-computed';
  log.log('info', 'collector', `usage provenance for ${upstreamHost}: ${usageSource}`);

  const proxy = startProxy({
    host: cfg.host,
    port: cfg.proxyPort,
    upstream: cfg.upstream,
    adapters: createAdapters({ usageSource }),
    emit: (ev) => queue.push(ev),
    logger: log,
  });

  // Weekly cleanup; VACUUM after deletes (freelist pages hold ghost bodies).
  // Disabled for in-memory DBs (tests drive retention directly).
  const stopRetention =
    cfg.dbPath === ':memory:' ? () => {} : scheduleRetention(db, DEFAULT_RETENTION, log);

  // Borrow session titles / cwd / branch from the CLIENT's own local
  // transcripts, keyed on the session id the client states on the wire. Uses
  // the writer's handle because it writes, same as analytics below.
  //
  // Off for in-memory DBs: that is the test configuration, and a test must
  // never wander into the developer's real ~/.claude/projects.
  const stopEnrichment =
    cfg.dbPath === ':memory:'
      ? () => {}
      : scheduleEnrichment(db, {
          log: (level, message) => log.log(level, 'enrich', message),
        });

  // Reads go through their own connection: WAL lets them proceed while the
  // writer writes, and it is the same isolation P4's SQL endpoint requires.
  const readDb = cfg.dbPath === ':memory:' ? db : openDatabase(cfg.dbPath, { readonly: true });

  const uiDir = cfg.uiDir ?? resolve('apps', 'web', 'dist');
  const api = startApiServer({
    host: cfg.host,
    port: cfg.apiPort,
    db: readDb,
    dbPath: cfg.dbPath,
    // The main handle, not readDb: the analytics backend maintains its daily
    // rollup lazily, which is a write. Same-thread reads are safe.
    analytics: new SqliteAnalytics(db),
    events: queue,
    proxy,
    version: cfg.version ?? '0.1.0',
    logger: log,
    logLines: (after, limit) => log.lines(after, limit),
    staticDir: uiDir,
  });

  return {
    config: cfg,
    proxy,
    api,
    db,
    writer,
    queue,
    logger: log,
    snapshot: (dest: string) => snapshotTo(db, dest),
    stop: () => {
      stopRetention();
      stopEnrichment();
      proxy.stop();
      api.stop();
      queue.flushSync();
      if (readDb !== db) readDb.close();
      db.close();
    },
  };
}
