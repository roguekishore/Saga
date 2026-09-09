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
 */
export const UsageSchema = z.object({
  input: UsageValueSchema.nullable(),
  output: UsageValueSchema.nullable(),
  cacheRead: UsageValueSchema.nullable(),
  cacheWrite: UsageValueSchema.nullable(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const emptyUsage = (): Usage => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
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
