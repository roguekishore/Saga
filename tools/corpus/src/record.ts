import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Traffic recorder: a minimal tap-proxy that saves raw request/response pairs
 * as fixture-shaped JSON under `tools/corpus/recorded/` — which is GITIGNORED.
 * Recorded real traffic never enters history, redacted or not (brief §2.4);
 * promote a recording by hand-authoring a synthetic fixture from its shape.
 *
 *   bun tools/corpus/src/record.ts --upstream http://127.0.0.1:8000 --port 9797
 */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length - 1; i += 2) {
  args.set(process.argv[i] ?? '', process.argv[i + 1] ?? '');
}
const upstream = args.get('--upstream') ?? 'http://127.0.0.1:8000';
const port = Number(args.get('--port') ?? 9797);
const outDir = join(import.meta.dir, '..', 'recorded');
mkdirSync(outDir, { recursive: true });

let n = 0;

Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const bodyText = req.method === 'GET' || req.method === 'HEAD' ? null : await req.text();

    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!['host', 'accept-encoding', 'connection'].includes(k.toLowerCase())) headers.set(k, v);
    });
    headers.set('accept-encoding', 'identity');

    const res = await fetch(upstream + path, {
      method: req.method,
      headers,
      body: bodyText ?? undefined,
    });

    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const isSse = contentType.includes('text/event-stream');

    const seq = String(n++).padStart(4, '0');
    const file = join(outDir, `${Date.now()}-${seq}${url.pathname.replaceAll('/', '_')}.json`);
    const reqHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      reqHeaders[k] = v;
    });
    writeFileSync(
      file,
      JSON.stringify(
        {
          name: `recorded-${seq}`,
          description: `RAW RECORDING (local only, gitignored). ${req.method} ${path}`,
          request: {
            method: req.method,
            path: url.pathname,
            headers: reqHeaders,
            body: bodyText ? JSON.parse(bodyText) : null,
          },
          response: {
            status: res.status,
            contentType,
            ...(isSse
              ? { sseFrames: raw.split(/\r?\n\r?\n/).filter(Boolean) }
              : { json: safeParse(raw) }),
          },
        },
        null,
        2,
      ),
    );
    console.error(`[record] ${req.method} ${path} -> ${res.status} (${file})`);

    return new Response(raw, {
      status: res.status,
      headers: { 'content-type': contentType || 'application/octet-stream' },
    });
  },
});

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

console.error(`[record] tap proxy on http://127.0.0.1:${port} -> ${upstream}; writing ${outDir}`);
console.error('[record] recordings are raw and LOCAL ONLY — never commit them.');
