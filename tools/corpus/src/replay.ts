import type { Fixture } from './fixtures';

/**
 * Replay upstream: a tiny local server that answers like a gateway, from
 * fixtures. This is what stands in for the live kiro-gateway on machines
 * where it is not running — SAGA's own tests exercise the REAL proxy path
 * against it (real sockets, real SSE, hostile chunking), not a mocked fetch.
 *
 * Fixture selection: `x-saga-fixture` header wins; otherwise first fixture
 * matching method+path.
 */
export interface ReplayHandle {
  port: number;
  url: string;
  requestsServed(): number;
  stop(): void;
}

export function startReplayUpstream(fixtures: Fixture[], port = 0): ReplayHandle {
  let served = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/__fixtures') {
        return Response.json(fixtures.map((f) => ({ name: f.name, path: f.request.path })));
      }
      const wanted = req.headers.get('x-saga-fixture');
      const fx = wanted
        ? fixtures.find((f) => f.name === wanted)
        : fixtures.find((f) => f.request.method === req.method && f.request.path === url.pathname);
      if (!fx) {
        return Response.json(
          { error: { type: 'no_fixture', message: url.pathname } },
          { status: 404 },
        );
      }
      served++;
      const r = fx.response;

      if (r.sseFrames) {
        const whole = r.sseFrames.map((f) => (f.endsWith('\n\n') ? f : `${f}\n\n`)).join('');
        const bytes = new TextEncoder().encode(whole);
        const chunk = r.chunkBytes && r.chunkBytes > 0 ? r.chunkBytes : bytes.length;
        const delay = r.frameDelayMs ?? 0;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < bytes.length; i += chunk) {
              controller.enqueue(bytes.slice(i, i + chunk));
              if (delay > 0) await new Promise((res) => setTimeout(res, delay));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: r.status,
          headers: { 'content-type': r.contentType },
        });
      }

      return new Response(JSON.stringify(r.json ?? null), {
        status: r.status,
        headers: { 'content-type': r.contentType },
      });
    },
  });

  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}`,
    requestsServed: () => served,
    stop: () => server.stop(true),
  };
}
