import type { Driver } from './driver';

/**
 * Live-safe snapshot. NEVER `cp` a WAL database — the -wal file holds
 * unmerged pages and the copy is torn. `VACUUM INTO` produces a compact,
 * consistent single-file snapshot through SQLite itself.
 */
export function snapshotTo(db: Driver, destPath: string): void {
  if (destPath.includes("'")) throw new Error('snapshot path must not contain single quotes');
  db.exec(`VACUUM INTO '${destPath}'`);
}
