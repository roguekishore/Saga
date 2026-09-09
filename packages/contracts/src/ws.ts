import { z } from 'zod';
import { NormalizedEventSchema } from './events';

/**
 * WebSocket envelope on `/ws`. The server sends `hello` on connect, then a
 * mix of request-scoped `event` frames and periodic `metrics` heartbeats.
 * Clients fetch initial state over REST; the socket carries deltas only.
 */

export const WsHelloSchema = z.object({
  type: z.literal('hello'),
  serverVersion: z.string(),
  now: z.number(),
});

export const WsEventSchema = z.object({
  type: z.literal('event'),
  event: NormalizedEventSchema,
});

export const WsMetricsSchema = z.object({
  type: z.literal('metrics'),
  ts: z.number(),
  queue: z.object({
    depth: z.number().int(),
    capacity: z.number().int(),
    dropped: z.number().int(),
  }),
  activeRequests: z.number().int(),
  wsClients: z.number().int(),
});

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  WsHelloSchema,
  WsEventSchema,
  WsMetricsSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
export type WsMetrics = z.infer<typeof WsMetricsSchema>;
