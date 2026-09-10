import type { ContentBlock, ContextSource, NormalizedMessage, Provenance } from '@saga/contracts';

/** Options shared by all adapters, decided by the collector per upstream. */
export interface AdapterOptions {
  /**
   * Provenance of usage numbers read off the wire. `upstream-reported` only
   * when the upstream IS the provider (api.anthropic.com etc.); anything with
   * a gateway in the middle is `gateway-computed` — on kiro that is tiktoken
   * cl100k_base × ~1.15, an estimate wearing a usage field.
   */
  usageSource: Extract<Provenance, 'upstream-reported' | 'gateway-computed'>;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

export function unknownBlock(raw: unknown, rawType: string): ContentBlock {
  return { type: 'unknown', rawType, json: safeStringify(raw) };
}

export function textMessage(
  role: NormalizedMessage['role'],
  blocks: ContentBlock[],
  contextSource: ContextSource,
  inferred = false,
): NormalizedMessage {
  return { role, blocks, contextSource, contextSourceInferred: inferred };
}

/**
 * Structural context sourcing for a chat-shaped message array: everything
 * before the final message is prior-turn history; the final message is the
 * live turn. Messages consisting solely of tool results are `tool`. This is
 * derived from position, not guessed — `inferred` stays false. The
 * memory/spec heuristics (P2+) are the inferred ones.
 */
export function structuralContextSource(
  index: number,
  total: number,
  role: NormalizedMessage['role'],
  toolOnly: boolean,
): ContextSource {
  if (toolOnly) return 'tool';
  if (index < total - 1) return 'history';
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return 'unknown';
}
