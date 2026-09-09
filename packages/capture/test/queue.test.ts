import { describe, expect, test } from 'bun:test';
import type { NormalizedEvent } from '@saga/contracts';
import { BoundedEventQueue } from '../src/queue';

function ev(n: number): NormalizedEvent {
  return { kind: 'first_token', requestId: `req_${n}`, ts: n, ttftMs: 1 };
}

describe('BoundedEventQueue', () => {
  test('drop-oldest under pressure, counter exposed, never grows past capacity', async () => {
    const q = new BoundedEventQueue(8);
    const seen: string[] = [];
    q.subscribe((e) => seen.push(e.requestId));
    for (let i = 0; i < 30; i++) q.push(ev(i));
    expect(q.stats().depth).toBeLessThanOrEqual(8);
    await new Promise((r) => setTimeout(r, 10));
    const s = q.stats();
    expect(s.dropped).toBe(30 - seen.length);
    expect(s.dropped).toBeGreaterThan(0);
    // the NEWEST events survived; oldest were shed
    expect(seen.at(-1)).toBe('req_29');
    expect(seen).not.toContain('req_0');
  });

  test('a throwing subscriber cannot break delivery to others', async () => {
    const q = new BoundedEventQueue(64);
    const seen: string[] = [];
    q.subscribe(() => {
      throw new Error('boom');
    });
    q.subscribe((e) => seen.push(e.requestId));
    q.push(ev(1));
    q.push(ev(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['req_1', 'req_2']);
    expect(q.stats().subscriberErrors).toBe(2);
  });

  test('flushSync drains everything for shutdown', () => {
    const q = new BoundedEventQueue(64);
    const seen: string[] = [];
    q.subscribe((e) => seen.push(e.requestId));
    for (let i = 0; i < 10; i++) q.push(ev(i));
    q.flushSync();
    expect(seen.length).toBe(10);
    expect(q.stats().depth).toBe(0);
  });
});
