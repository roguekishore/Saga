import { startCollector } from '@saga/collector';
import { loadFixtures } from './fixtures';
import { startReplayUpstream } from './replay';

/**
 * Seed a dev database by replaying the fixture corpus through the REAL stack
 * (proxy → queue → writer). Gives the dashboard live-shaped data without a
 * gateway.
 *
 *   bun tools/corpus/src/seed.ts [dbPath] [rounds]
 */
const dbPath = process.argv[2] ?? 'storage/saga.db';
const rounds = Number(process.argv[3] ?? 1);

const fixtures = loadFixtures();
const replay = startReplayUpstream(fixtures);
const collector = startCollector({
  host: '127.0.0.1',
  proxyPort: 0,
  apiPort: 0,
  upstream: replay.url,
  dbPath,
  queueCapacity: 4096,
});

const proxyUrl = `http://127.0.0.1:${collector.proxy.port}`;
let ok = 0;
let failed = 0;

for (let round = 0; round < rounds; round++) {
  for (const fx of fixtures) {
    const res = await fetch(proxyUrl + fx.request.path, {
      method: fx.request.method,
      headers: { ...fx.request.headers, 'x-saga-fixture': fx.name },
      body: fx.request.body == null ? undefined : JSON.stringify(fx.request.body),
    });
    await res.text(); // drain like a real client
    res.ok ? ok++ : failed++;
  }
}

await new Promise((r) => setTimeout(r, 300)); // let the queue drain
collector.queue.flushSync();
console.log(
  `[seed] replayed ${ok + failed} fixture requests (${failed} non-2xx by design) into ${dbPath}`,
);
collector.stop();
replay.stop();
