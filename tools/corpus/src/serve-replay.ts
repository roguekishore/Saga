import { loadFixtures } from './fixtures';
import { startReplayUpstream } from './replay';

/**
 * Standalone replay upstream for local dev:
 *   bun tools/corpus/src/serve-replay.ts [port]
 * Point the collector at it with SAGA_UPSTREAM=http://127.0.0.1:<port>.
 */
const port = Number(process.argv[2] ?? 8999);
const handle = startReplayUpstream(loadFixtures(), port);
console.log(`[replay] fixture upstream on ${handle.url} (${loadFixtures().length} fixtures)`);
