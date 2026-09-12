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
  /** Door A: Claude Code + Codex, upstream to CONDUIT. */
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
  /**
   * Door B: Gemini, plain passthrough to Google. A SECOND proxy instance rather
   * than per-request routing inside door A — routing in the hot path would mean
   * provider branching in the capture layer, which the architecture forbids.
   */
  doorBEnabled?: boolean;
  doorBPort?: number;
  doorBUpstream?: string;
}

/**
 * Hosts where the upstream IS the provider, so usage numbers read off the wire
 * are `upstream-reported` rather than `gateway-computed`.
 *
 * `aiplatform.googleapis.com` is the Vertex door SAGA actually proxies for
 * Gemini. Its absence was a real provenance bug in waiting: the list carried
 * only `generativelanguage.googleapis.com` (the consumer Gemini API, which this
 * deployment does not use), so door B's six lossless `usageMetadata` counters —
 * the one feed whose numbers are exact — would have been labeled
 * gateway-computed.
 */
export const DEFAULT_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
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
    // Door B is OPT-IN. Binding a second port by default would be a surprise on
    // every existing install, and a door with no Gemini traffic behind it is just
    // an extra open socket.
    doorBEnabled: env.SAGA_DOOR_B === '1' || env.SAGA_DOOR_B === 'true',
    // 8788 is the read API, so door B takes 8789.
    doorBPort: Number(env.SAGA_DOOR_B_PORT ?? 8789),
    doorBUpstream: env.SAGA_DOOR_B_UPSTREAM ?? 'https://aiplatform.googleapis.com',
  };
}

export interface CollectorHandle {
  config: CollectorConfig;
  /** Door A — Claude Code + Codex, upstream CONDUIT. */
  proxy: ProxyHandle;
  /** Door B — Gemini, upstream Google. Null unless enabled. */
  doorB: ProxyHandle | null;
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
  try {
    runMigrations(db, MIGRATIONS);
  } catch (err) {
    // WS-C replaced the migration history with a single fresh `init` because the
    // pre-WS-C corpus is explicitly not wanted. The runner refuses to touch a
    // database whose history diverges from the code, which is the correct and
    // desired behavior — it protects the old file instead of corrupting it. What
    // it does not do on its own is explain itself, so translate it here.
    //
    // Deliberately NOT deleting or renaming anything: destroying a 200MB capture
    // corpus is the operator's call, never the process's.
    const msg = String(err);
    if (msg.includes('diverged')) {
      log.log(
        'error',
        'store',
        `migration history diverged from this build: ${msg}. ` +
          `SAGA's schema was rebuilt for the observability hierarchy, and the database at ` +
          `${cfg.dbPath} predates it. Nothing has been modified. Move ${cfg.dbPath} ` +
          `(and its -wal/-shm siblings) aside, then start again — a fresh database will be created.`,
      );
    }
    db.close();
    throw err;
  }

  const writer = new StoreWriter(db, log);
  const orphans = writer.reconcileInFlight();
  if (orphans > 0)
    log.log('info', 'store', `marked ${orphans} orphaned request(s) capture_incomplete`);

  const queue = new BoundedEventQueue(cfg.queueCapacity, log);
  queue.subscribe((ev) => writer.handleEvent(ev));

  const providerHosts = cfg.providerHosts ?? DEFAULT_PROVIDER_HOSTS;

  /**
   * Provenance is PER DOOR, not per process.
   *
   * This used to be computed once and shared, which was correct while there was
   * one upstream. With two doors it is wrong in both directions: door A ends at
   * CONDUIT (a gateway, so `gateway-computed`) while door B ends at Google itself
   * (the provider, so `upstream-reported`). One shared value would mislabel one of
   * them, and the one at risk was door B — the only feed whose token counts are
   * exact.
   */
  const usageSourceFor = (upstream: string): 'upstream-reported' | 'gateway-computed' => {
    const host = new URL(upstream).hostname;
    const source = providerHosts.includes(host) ? 'upstream-reported' : 'gateway-computed';
    log.log('info', 'collector', `usage provenance for ${host}: ${source}`);
    return source;
  };

  const proxy = startProxy({
    host: cfg.host,
    port: cfg.proxyPort,
    upstream: cfg.upstream,
    door: 'A',
    adapters: createAdapters({ usageSource: usageSourceFor(cfg.upstream) }),
    emit: (ev) => queue.push(ev),
    logger: log,
  });

  // Door B — Gemini, straight to Google. Opt-in, its own adapter chain (so it
  // carries its own provenance), same queue and same single writer: two doors,
  // one store.
  const doorBUpstream = cfg.doorBUpstream ?? 'https://aiplatform.googleapis.com';
  const doorB = cfg.doorBEnabled
    ? startProxy({
        host: cfg.host,
        port: cfg.doorBPort ?? 8789,
        upstream: doorBUpstream,
        door: 'B',
        adapters: createAdapters({ usageSource: usageSourceFor(doorBUpstream) }),
        emit: (ev) => queue.push(ev),
        logger: log,
      })
    : null;

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
    // The CONDUIT ingest seam pushes onto the same queue the proxy feeds, rather
    // than writing to SQLite — `writer` is the single writer, and enqueueing is
    // what makes the seam's fire-and-forget guarantee free instead of something
    // the handler has to arrange.
    emit: (ev) => queue.push(ev),
  });

  return {
    config: cfg,
    proxy,
    doorB,
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
      doorB?.stop();
      api.stop();
      queue.flushSync();
      if (readDb !== db) readDb.close();
      db.close();
    },
  };
}
