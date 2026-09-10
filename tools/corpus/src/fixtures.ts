import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fixture corpus. COMMIT POLICY (brief §2.4, resolved): committed fixtures
 * are synthetic or hand-authored ONLY. Recorded real traffic lands in
 * `tools/corpus/recorded/` which is gitignored — it never enters history,
 * redacted or not.
 */

export interface Fixture {
  name: string;
  description: string;
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    contentType: string;
    /** Complete SSE records; the replay server appends the blank line. */
    sseFrames?: string[];
    json?: unknown;
    /** Hostile chunk size in bytes; 0/undefined = one frame per write. */
    chunkBytes?: number;
    frameDelayMs?: number;
  };
}

export const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures');

export function loadFixtures(dir: string = FIXTURES_DIR): Fixture[] {
  const out: Fixture[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Fixture | Fixture[];
    out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return out;
}

export function getFixture(name: string, dir?: string): Fixture {
  const fx = loadFixtures(dir).find((f) => f.name === name);
  if (!fx) throw new Error(`fixture not found: ${name}`);
  return fx;
}
