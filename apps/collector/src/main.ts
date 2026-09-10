import { runSqlChild } from '@saga/api';
import { configFromEnv, startCollector } from './collector';
import { createOtelExporter } from './otel';

// SQL child mode: the compiled collector binary re-spawns ITSELF with this
// flag to execute one read-only query off the event loop (see @saga/api sql).
// Must short-circuit before any server starts.
if (process.argv.includes('--saga-sql-worker')) {
  await runSqlChild(process.argv);
  process.exit(0);
}

const cfg = configFromEnv();
const collector = startCollector(cfg);

// W2 platform hooks. OTel: one span per finished request, OTLP/HTTP JSON.
let stopOtel: (() => void) | null = null;
if (process.env.SAGA_OTLP_ENDPOINT) {
  const otel = createOtelExporter(process.env.SAGA_OTLP_ENDPOINT, collector.logger);
  collector.queue.subscribe(otel.subscriber);
  stopOtel = otel.stop;
  collector.logger.log('info', 'otel', `exporting traces to ${process.env.SAGA_OTLP_ENDPOINT}`);
}

// Plugin hook: SAGA_PLUGIN=./my-plugin.ts default-exports (handle) => void.
// The bounded queue's subscribe() is the extension point; a plugin that
// throws loses events, never breaks capture (contained by the queue).
if (process.env.SAGA_PLUGIN) {
  import(process.env.SAGA_PLUGIN)
    .then((mod: { default?: (c: typeof collector) => void }) => {
      mod.default?.(collector);
      collector.logger.log('info', 'plugin', `loaded ${process.env.SAGA_PLUGIN}`);
    })
    .catch((err) =>
      collector.logger.log('error', 'plugin', `failed to load ${process.env.SAGA_PLUGIN}: ${err}`),
    );
}

console.log(
  [
    '',
    '  SAGA collector up',
    `    proxy      http://${collector.proxy.host}:${collector.proxy.port}  ->  ${cfg.upstream}`,
    `    read api   http://${collector.api.host}:${collector.api.port}`,
    `    database   ${cfg.dbPath}`,
    '',
    '  Point a client at the proxy, e.g.:',
    `    ANTHROPIC_BASE_URL=http://${collector.proxy.host}:${collector.proxy.port}`,
    '',
    '  Loopback only. No auth on the read API — do not port-forward it.',
    '',
  ].join('\n'),
);

// Last line of defence for invariant 2 (capture failures never propagate).
// Some failures are not ours to catch: Bun raises stream-teardown errors from
// internal closures on promises SAGA does not own, so no try/catch in the
// proxy can see them. Left unhandled they take the whole collector down and
// every in-flight capture with it. Log and keep serving instead.
process.on('unhandledRejection', (reason) => {
  collector.logger.log(
    'error',
    'runtime',
    `unhandled rejection (contained): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});
process.on('uncaughtException', (err) => {
  collector.logger.log(
    'error',
    'runtime',
    `uncaught exception (contained): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.error(`[saga] ${signal} — draining queue and closing`);
  stopOtel?.();
  collector.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
