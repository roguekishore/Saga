import { z } from 'zod';

/**
 * Where a number came from. Every token/cost figure in SAGA carries one of
 * these, end to end — schema, store, API, UI. A number with no source is a
 * bug, not a default.
 *
 * - `upstream-reported`: the provider itself returned it (e.g. Anthropic usage).
 * - `gateway-computed`: an intermediate gateway computed it (e.g. kiro-gateway's
 *   tiktoken-times-1.15 estimate delivered in `message_start.usage`).
 * - `saga-estimated`: SAGA derived it (chars/4 fallback). Least trustworthy.
 */
export const ProvenanceSchema = z.enum(['upstream-reported', 'gateway-computed', 'saga-estimated']);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const UsageValueSchema = z.object({
  value: z.number().int().nonnegative(),
  source: ProvenanceSchema,
});
export type UsageValue = z.infer<typeof UsageValueSchema>;

/**
 * Usage for one request. `null` means "no source exists", and the UI renders
 * n/a — it is never coerced to 0. On the kiro upstream, cacheRead/cacheWrite
 * are always null: nothing produces them (verified 2026-09-01).
 *
 * Six counters, because both feeds added by WS-C carry more than four:
 *
 * - Kiro meters reasoning as its own line item (`thoughtTokens`), so once
 *   native reasoning is on, the reasoning portion of a tier is separately
 *   priceable. Nothing in the gateway survey exposed this.
 * - Gemini's Vertex door returns six counters losslessly in `usageMetadata`
 *   (`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`,
 *   `cachedContentTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`).
 *
 * `thought` and `total` are OPTIONAL rather than required-nullable on purpose:
 * an adapter that predates them keeps type-checking, which is what lets the
 * six WS-C workstreams land in parallel without a lockstep edit to every
 * observer. Read them with `?? null`; absent and null mean the same thing.
 *
 * Gemini's `toolUsePromptTokenCount` deliberately gets NO slot — it has no
 * analogue on the Kiro feed, and inventing a seventh counter for one provider
 * would put a provider quirk in a shared contract. It stays in that adapter's
 * raw params.
 */
export const UsageSchema = z.object({
  input: UsageValueSchema.nullable(),
  output: UsageValueSchema.nullable(),
  cacheRead: UsageValueSchema.nullable(),
  cacheWrite: UsageValueSchema.nullable(),
  /** Reasoning tokens, metered separately by Kiro and reported by Gemini. */
  thought: UsageValueSchema.nullable().optional(),
  /** Provider-stated total. NOT computed by SAGA — a sum it derived is an estimate. */
  total: UsageValueSchema.nullable().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const emptyUsage = (): Usage => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  thought: null,
  total: null,
});

/**
 * An aggregate over many requests whose individual values may have different
 * provenance. `sources` lists every provenance that contributed, so the UI can
 * say "12.4k tokens (gateway-computed)" or "mixed sources".
 */
export const AggUsageSchema = z.object({
  value: z.number().int().nonnegative(),
  sources: z.array(ProvenanceSchema),
});
export type AggUsage = z.infer<typeof AggUsageSchema>;

/**
 * Rank of a provenance claim. Higher wins.
 *
 * This exists because on Door A two independent writers touch the same token
 * columns: the stream observer, which reads CONDUIT's client-facing response
 * and therefore sees CONDUIT's *estimates*, and the CONDUIT ingest seam, which
 * carries figures parsed from Kiro's own metadataEvent/meteringEvent.
 *
 * They can land in either order, so "last write wins" would discard the real
 * numbers roughly half the time — the exact failure the measurement apparatus
 * exists to prevent. Resolution is by rank, never by arrival.
 */
const PROVENANCE_RANK: Record<Provenance, number> = {
  'upstream-reported': 3,
  'gateway-computed': 2,
  'saga-estimated': 1,
};

/**
 * Accepts `string`, not just `Provenance`, on purpose: the store keeps
 * provenance in a TEXT column, so a value read back is only as trustworthy as
 * whatever wrote it. An unrecognized claim ranks LOWEST (0) — the weaker
 * reading, consistent with every other default in these contracts — so a
 * corrupt or future value can never outrank a real measurement.
 */
export function provenanceRank(p: string): number {
  return PROVENANCE_RANK[p as Provenance] ?? 0;
}

/**
 * Pick the better-sourced of two readings for the same figure. Ties keep the
 * incumbent: a same-provenance re-report carries no new information, and
 * preferring the incumbent makes the merge idempotent under a duplicate emit.
 */
export function preferBetterSourced(
  incumbent: UsageValue | null | undefined,
  candidate: UsageValue | null | undefined,
): UsageValue | null {
  if (!candidate) return incumbent ?? null;
  if (!incumbent) return candidate;
  return provenanceRank(candidate.source) > provenanceRank(incumbent.source)
    ? candidate
    : incumbent;
}
