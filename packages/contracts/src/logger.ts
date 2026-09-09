/**
 * Cross-cutting logger interface. Packages never write to disk or stdout on
 * their own — the composition layer (apps/collector) provides the sink, which
 * runs everything through redaction before persisting. Log lines are what the
 * P4 Logs Explorer shows.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, scope: string, message: string): void;
}

export const noopLogger: Logger = { log() {} };
