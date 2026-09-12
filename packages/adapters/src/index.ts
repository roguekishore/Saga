import type { Adapter } from '@saga/contracts';
import { anthropicAdapter } from './anthropic';
import { codexResponsesAdapter } from './codex-responses';
import { geminiAdapter } from './gemini';
import { openaiAdapter } from './openai';
import { passthroughAdapter } from './passthrough';
import type { AdapterOptions } from './shared';

export { anthropicAdapter } from './anthropic';
export { codexResponsesAdapter } from './codex-responses';
export { geminiAdapter } from './gemini';
export { openaiAdapter } from './openai';
export { passthroughAdapter } from './passthrough';
export type { AdapterOptions } from './shared';

/**
 * The standard adapter chain, most specific first. Passthrough is always
 * last — every request matches something, nothing is dropped.
 *
 * Every adapter is registered on BOTH doors rather than filtered per door, and
 * that is deliberate: each `matches()` is already specific (Gemini only accepts
 * the Vertex colon-method path, Codex only `/responses`), so a door filter would
 * duplicate that discrimination in a second place where the two could drift.
 * The collector instead calls this once per door with that door's own
 * `usageSource` — which is the thing that genuinely differs, because door A ends
 * at a gateway and door B ends at the provider.
 */
export function createAdapters(opts: AdapterOptions): Adapter[] {
  return [
    anthropicAdapter(opts),
    codexResponsesAdapter(),
    geminiAdapter(),
    openaiAdapter(opts),
    passthroughAdapter(),
  ];
}
