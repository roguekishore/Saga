import type { Adapter } from '@saga/contracts';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { passthroughAdapter } from './passthrough';
import type { AdapterOptions } from './shared';

export { anthropicAdapter } from './anthropic';
export { openaiAdapter } from './openai';
export { passthroughAdapter } from './passthrough';
export type { AdapterOptions } from './shared';

/**
 * The standard adapter chain, most specific first. Passthrough is always
 * last — every request matches something, nothing is dropped.
 */
export function createAdapters(opts: AdapterOptions): Adapter[] {
  return [anthropicAdapter(opts), openaiAdapter(opts), passthroughAdapter()];
}
