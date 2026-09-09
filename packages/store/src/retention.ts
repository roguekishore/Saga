import type { Logger } from '@saga/contracts';
import { noopLogger } from '@saga/contracts';
import type { Driver } from './driver';

/**
 * Retention tiers, from the master plan, with implementable semantics:
 *
 *   hot     (< hotDays)          everything as captured
 *   warm    (hotDays..warmDays)  bodies kept, tier marked (bodies are already
 *                                Brotli-compressed at write time)
 *   cold    (warmDays..coldDays) input/history bodies dropped; the system
 *                                prompt and the assistant response are kept as
 *                                the exchange's summary; metrics untouched
 *   archive (> coldDays)         all bodies dropped; request rows (tokens,
 *                                latency, model, status) retained for analytics
 *
 * THE TRAP this module exists for: deleted prompt bodies linger in SQLite
 * freelist pages until VACUUM. Retention without a vacuum pass deletes
 * nothing an attacker would notice. After the delete pass, if freelist
 * exceeds `vacuumFreelistRatio` of the file, we VACUUM (and always record
 * both timestamps in meta).
 */

export interface RetentionPolicy {
  hotDays: number;
  warmDays: number;
  coldDays: number;
  /** VACUUM when freelist_count/page_count exceeds this after cleanup. */
  vacuumFreelistRatio: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  hotDays: 30,
  warmDays: 90,
  coldDays: 180,
  vacuumFreelistRatio: 0.1,
};

export interface RetentionReport {
  tiered: { warm: number; cold: number; archive: number };
  linksDeleted: number;
  messagesDeleted: number;
  ftsDeleted: number;
  vacuumed: boolean;
  freedPagesBeforeVacuum: number;
}

const DAY = 86_400_000;

export function runRetention(
  db: Driver,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
  log: Logger = noopLogger,
): RetentionReport {
  const warmBefore = now - policy.hotDays * DAY;
  const coldBefore = now - policy.warmDays * DAY;
  const archiveBefore = now - policy.coldDays * DAY;

  const report: RetentionReport = {
    tiered: { warm: 0, cold: 0, archive: 0 },
    linksDeleted: 0,
    messagesDeleted: 0,
    ftsDeleted: 0,
    vacuumed: false,
    freedPagesBeforeVacuum: 0,
  };

  db.transaction(() => {
    // ---- tier marking (idempotent)
    report.tiered.warm = db
      .prepare(`UPDATE requests SET tier = 'warm' WHERE ts < ? AND ts >= ? AND tier = 'hot'`)
      .run(warmBefore, coldBefore).changes;
    report.tiered.cold = db
      .prepare(
        `UPDATE requests SET tier = 'cold' WHERE ts < ? AND ts >= ? AND tier IN ('hot','warm')`,
      )
      .run(coldBefore, archiveBefore).changes;
    report.tiered.archive = db
      .prepare(`UPDATE requests SET tier = 'archive' WHERE ts < ? AND tier != 'archive'`)
      .run(archiveBefore).changes;

    // ---- cold: drop input/history links; keep system + output as summary
    const coldLinks = db
      .prepare(
        `DELETE FROM request_messages
         WHERE segment = 'input'
           AND request_id IN (SELECT request_id FROM requests WHERE tier = 'cold')`,
      )
      .run().changes;

    // cold also sheds the raw request body (biggest single blob per request)
    db.prepare(
      `UPDATE requests SET raw_request_msg_id = NULL
       WHERE tier IN ('cold','archive') AND raw_request_msg_id IS NOT NULL`,
    ).run();

    // ---- archive: drop every link
    const archiveLinks = db
      .prepare(
        `DELETE FROM request_messages
         WHERE request_id IN (SELECT request_id FROM requests WHERE tier = 'archive')`,
      )
      .run().changes;

    report.linksDeleted = coldLinks + archiveLinks;

    // ---- garbage-collect unreferenced messages (links AND raw pointers gone)
    const doomed = db
      .prepare<{ id: number; raw_bytes: number; stored_bytes: number }>(
        `SELECT m.id, m.raw_bytes, m.stored_bytes FROM messages m
         WHERE NOT EXISTS (SELECT 1 FROM request_messages rm WHERE rm.message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.raw_request_msg_id = m.id)`,
      )
      .all();
    const delFts = db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`);
    const delMsg = db.prepare(`DELETE FROM messages WHERE id = ?`);
    let freedRaw = 0;
    let freedStored = 0;
    for (const { id, raw_bytes, stored_bytes } of doomed) {
      delFts.run(id);
      delMsg.run(id);
      freedRaw += raw_bytes;
      freedStored += stored_bytes;
    }
    report.messagesDeleted = doomed.length;
    report.ftsDeleted = doomed.length;
    if (doomed.length > 0) {
      const bump = db.prepare(
        `INSERT INTO meta (k, v) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + CAST(excluded.v AS INTEGER) AS TEXT)`,
      );
      bump.run('msg_raw_bytes_total', String(-freedRaw));
      bump.run('msg_stored_bytes_total', String(-freedStored));
    }

    db.prepare(
      `INSERT INTO meta (k, v) VALUES ('last_cleanup_at', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(String(now));
  });

  // ---- the vacuum policy (outside any transaction; VACUUM demands it)
  const freelist = Number(db.pragma('freelist_count') ?? 0);
  const pages = Math.max(1, Number(db.pragma('page_count') ?? 1));
  report.freedPagesBeforeVacuum = freelist;
  if (freelist / pages > policy.vacuumFreelistRatio) {
    db.exec('VACUUM');
    report.vacuumed = true;
    db.prepare(
      `INSERT INTO meta (k, v) VALUES ('last_vacuum_at', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(String(now));
  }

  log.log(
    'info',
    'retention',
    `tiers w/c/a=${report.tiered.warm}/${report.tiered.cold}/${report.tiered.archive}, ` +
      `links-${report.linksDeleted}, msgs-${report.messagesDeleted}, ` +
      `freelist ${freelist}/${pages} pages, vacuum=${report.vacuumed}`,
  );
  return report;
}

/** Weekly scheduler hook for the collector. Returns a stop function. */
export function scheduleRetention(
  db: Driver,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  log: Logger = noopLogger,
  checkEveryMs = 6 * 3_600_000,
  weekMs = 7 * 86_400_000,
): () => void {
  const tick = (): void => {
    try {
      const last = db
        .prepare<{ v: string }>(`SELECT v FROM meta WHERE k = 'last_cleanup_at'`)
        .get();
      if (!last || Date.now() - Number(last.v) >= weekMs) {
        runRetention(db, policy, Date.now(), log);
      }
    } catch (err) {
      log.log('error', 'retention', `scheduled run failed: ${String(err)}`);
    }
  };
  tick();
  const t = setInterval(tick, checkEveryMs);
  return () => clearInterval(t);
}
