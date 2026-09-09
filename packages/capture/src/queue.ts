import type { Logger, NormalizedEvent } from '@saga/contracts';
import { noopLogger } from '@saga/contracts';

export interface QueueStats {
  depth: number;
  capacity: number;
  dropped: number;
  delivered: number;
  subscriberErrors: number;
}

/**
 * Bounded drop-oldest event queue between capture and its consumers.
 * Never blocks the producer, never grows past capacity; under pressure the
 * OLDEST event is shed and counted — the drop counter is a first-class
 * metric, not a log line. Subscriber failures are contained here: a broken
 * store or socket can lose events, never break capture.
 */
export class BoundedEventQueue {
  private buf: NormalizedEvent[] = [];
  private subscribers: Array<(ev: NormalizedEvent) => void> = [];
  private draining = false;
  private scheduled = false;
  readonly capacity: number;
  private droppedCount = 0;
  private deliveredCount = 0;
  private subscriberErrorCount = 0;
  private readonly log: Logger;

  constructor(capacity = 2048, log: Logger = noopLogger) {
    this.capacity = Math.max(8, capacity);
    this.log = log;
  }

  subscribe(fn: (ev: NormalizedEvent) => void): () => void {
    this.subscribers.push(fn);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== fn);
    };
  }

  push(ev: NormalizedEvent): void {
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
      this.droppedCount++;
      if (this.droppedCount === 1 || this.droppedCount % 100 === 0) {
        this.log.log('warn', 'queue', `dropped oldest event (total dropped: ${this.droppedCount})`);
      }
    }
    this.buf.push(ev);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.draining) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.drain();
    }, 0);
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      // Cap per tick so a burst cannot starve the event loop.
      let n = 0;
      while (this.buf.length > 0 && n < 512) {
        const ev = this.buf.shift()!;
        n++;
        for (const fn of this.subscribers) {
          try {
            fn(ev);
          } catch (err) {
            this.subscriberErrorCount++;
            this.log.log('error', 'queue', `subscriber failed on ${ev.kind}: ${String(err)}`);
          }
        }
        this.deliveredCount++;
      }
    } finally {
      this.draining = false;
      if (this.buf.length > 0) this.schedule();
    }
  }

  /** Drain everything synchronously (shutdown path). */
  flushSync(): void {
    while (this.buf.length > 0) this.drain();
  }

  stats(): QueueStats {
    return {
      depth: this.buf.length,
      capacity: this.capacity,
      dropped: this.droppedCount,
      delivered: this.deliveredCount,
      subscriberErrors: this.subscriberErrorCount,
    };
  }
}
