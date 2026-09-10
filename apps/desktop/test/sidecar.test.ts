import { afterAll, describe, expect, test } from 'bun:test';
import { waitForHealth } from '../src/sidecar.cjs';

let server: ReturnType<typeof Bun.serve> | null = null;

afterAll(() => server?.stop(true));

describe('desktop sidecar helpers', () => {
  test('waitForHealth resolves once /api/health answers, false when nothing listens', async () => {
    expect(await waitForHealth('http://127.0.0.1:9', 400)).toBe(false);

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === '/api/health'
          ? Response.json({ ok: true })
          : new Response('nope', { status: 404 });
      },
    });
    expect(await waitForHealth(`http://127.0.0.1:${server.port}`, 3000)).toBe(true);
  });
});
