import type { Logger, LogLevel } from '@saga/contracts';
import { scrubText } from '@saga/redact';

export interface RingLogger extends Logger {
  lines(
    afterSeq?: number,
    limit?: number,
  ): Array<{
    seq: number;
    ts: number;
    level: LogLevel;
    scope: string;
    message: string;
  }>;
}

/**
 * SAGA's own log channel (what the P4 Logs Explorer reads). Ring-buffered,
 * mirrored to stderr, and — like everything else that could persist —
 * scrubbed on the way in. Log lines quoting payloads must already be safe,
 * but the scrub makes that a property, not a convention.
 */
export function createRingLogger(capacity = 5000, mirror = true): RingLogger {
  const buf: Array<{ seq: number; ts: number; level: LogLevel; scope: string; message: string }> =
    [];
  let seq = 0;
  return {
    log(level: LogLevel, scope: string, message: string): void {
      const entry = {
        seq: seq++,
        ts: Date.now(),
        level,
        scope,
        message: scrubText(message).value.slice(0, 2000),
      };
      buf.push(entry);
      if (buf.length > capacity) buf.shift();
      if (mirror) {
        console.error(`[saga:${scope}] ${level}: ${entry.message}`);
      }
    },
    lines(afterSeq = -1, limit = 500) {
      return buf.filter((l) => l.seq > afterSeq).slice(0, limit);
    },
  };
}
