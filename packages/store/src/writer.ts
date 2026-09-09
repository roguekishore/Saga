import {
  blocksToText,
  type Logger,
  type NormalizedEvent,
  type NormalizedMessage,
  noopLogger,
  type RequestStarted,
  type ResponseFinished,
  type ToolUseObserved,
  type UsageValue,
} from '@saga/contracts';
import { encodeBody, sha256hex } from './codec';
import type { Driver, Statement } from './driver';

/**
 * Single-writer consumer of the capture queue. Everything arriving here is
 * already redacted (capture scrubs before enqueueing); this layer's jobs are
 * dedup, compression, linkage, and never throwing into the caller — a write
 * failure increments a counter and is logged, it does not take capture down.
 */
export class StoreWriter {
  private readonly db: Driver;
  private readonly log: Logger;
  writeErrors = 0;

  private readonly stmts: {
    upsertSession: Statement;
    touchSession: Statement;
    insertMessage: Statement<{ id: number; refs: number }>;
    insertFts: Statement;
    linkMessage: Statement;
    insertRequest: Statement;
    setTtft: Statement;
    upsertToolUse: Statement;
    upsertAgent: Statement;
    finishRequest: Statement;
    readHits: Statement<{ redaction_hits_json: string }>;
    findToolUse: Statement<{ request_id: string; ts: number; latency_ms: number | null }>;
    resolveToolUse: Statement;
    bumpMeta: Statement;
  };

  constructor(db: Driver, log: Logger = noopLogger) {
    this.db = db;
    this.log = log;
    this.stmts = {
      // `started_at` is never updated: a client-declared session id is derived,
      // not minted, so requests for one conversation can arrive after a
      // collector restart and must not reset when it began.
      upsertSession: db.prepare(
        `INSERT INTO sessions (session_id, started_at, last_activity_at, client_name, workspace,
                               client_session_id, session_id_source)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           started_at = MIN(sessions.started_at, excluded.started_at),
           last_activity_at = MAX(sessions.last_activity_at, excluded.last_activity_at),
           client_name = COALESCE(sessions.client_name, excluded.client_name),
           workspace = COALESCE(sessions.workspace, excluded.workspace),
           client_session_id = COALESCE(sessions.client_session_id, excluded.client_session_id),
           -- Wire evidence outranks a guess, and never the reverse.
           session_id_source = CASE
             WHEN sessions.session_id_source = 'client-declared'
               OR excluded.session_id_source = 'client-declared'
             THEN 'client-declared' ELSE sessions.session_id_source END`,
      ),
      touchSession: db.prepare(
        'UPDATE sessions SET last_activity_at = ? WHERE session_id = (SELECT session_id FROM requests WHERE request_id = ?)',
      ),
      insertMessage: db.prepare(
        `INSERT INTO messages (content_hash, role, kind, body, compressed, raw_bytes, stored_bytes, refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(content_hash) DO UPDATE SET refs = messages.refs + 1
         RETURNING id, refs`,
      ),
      insertFts: db.prepare('INSERT INTO messages_fts (rowid, content) VALUES (?, ?)'),
      linkMessage: db.prepare(
        `INSERT INTO request_messages (request_id, seq, message_id, segment, context_source, context_source_inferred)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      insertRequest: db.prepare(
        `INSERT INTO requests (
          request_id, session_id, ts, adapter_id, provider, endpoint, method, model, stream,
          message_count, redaction_flagged, redaction_hits_json, request_bytes, params_json,
          tools_json, raw_request_msg_id, agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      setTtft: db.prepare(
        'UPDATE requests SET ttft_ms = ? WHERE request_id = ? AND ttft_ms IS NULL',
      ),
      upsertToolUse: db.prepare(
        `INSERT INTO tool_uses (request_id, block_index, tool_use_id, name, input_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(request_id, block_index) DO UPDATE SET
           input_json = excluded.input_json, name = excluded.name, tool_use_id = excluded.tool_use_id`,
      ),
      upsertAgent: db.prepare(
        `INSERT INTO agents (agent_id, session_id, parent_agent_id, label, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      ),
      finishRequest: db.prepare(
        `UPDATE requests SET
          status = ?, http_status = ?, latency_ms = ?, ttft_ms = COALESCE(?, ttft_ms),
          input_tokens = ?, input_tokens_source = ?,
          output_tokens = ?, output_tokens_source = ?,
          cache_read_tokens = ?, cache_read_tokens_source = ?,
          cache_write_tokens = ?, cache_write_tokens_source = ?,
          stop_reason = ?, error_type = ?, error_message = ?,
          tool_use_count = ?, frames = ?, frame_bytes = ?, frame_parse_errors = ?,
          redaction_flagged = MAX(redaction_flagged, ?),
          redaction_hits_json = ?
         WHERE request_id = ?`,
      ),
      readHits: db.prepare('SELECT redaction_hits_json FROM requests WHERE request_id = ?'),
      findToolUse: db.prepare(
        `SELECT t.request_id AS request_id, r.ts AS ts, r.latency_ms AS latency_ms
         FROM tool_uses t JOIN requests r ON r.request_id = t.request_id
         WHERE t.tool_use_id = ? AND t.result_observed = 0
         ORDER BY r.ts DESC LIMIT 1`,
      ),
      resolveToolUse: db.prepare(
        `UPDATE tool_uses SET result_observed = 1, result_is_error = ?, result_request_id = ?, round_trip_ms = ?
         WHERE tool_use_id = ? AND request_id = ?`,
      ),
      bumpMeta: db.prepare(
        `INSERT INTO meta (k, v) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + CAST(excluded.v AS INTEGER) AS TEXT)`,
      ),
    };
  }

  handleEvent(ev: NormalizedEvent): void {
    try {
      switch (ev.kind) {
        case 'request_started':
          this.onStarted(ev);
          break;
        case 'first_token':
          this.stmts.setTtft.run(ev.ttftMs, ev.requestId);
          break;
        case 'tool_use_observed':
          this.onToolUse(ev);
          break;
        case 'response_finished':
          this.onFinished(ev);
          break;
        case 'capture_error':
          this.stmts.bumpMeta.run('capture_errors', '1');
          this.log.log('warn', 'store', `capture_error at ${ev.where}: ${ev.message}`);
          break;
        case 'token_stream':
          break; // live-only, never persisted per-tick
      }
    } catch (err) {
      this.writeErrors++;
      this.log.log('error', 'store', `write failed for ${ev.kind}: ${String(err)}`);
    }
  }

  /** Insert-or-ref a deduplicated message. Returns the message row id. */
  private storeMessage(
    msg: NormalizedMessage,
    kind: 'message' | 'raw_request',
    now: number,
  ): number {
    const canonical = JSON.stringify({ role: msg.role, blocks: msg.blocks });
    const hash = sha256hex(canonical);
    const enc = encodeBody(canonical);
    const row = this.stmts.insertMessage.get(
      hash,
      msg.role,
      kind,
      enc.body,
      enc.compressed ? 1 : 0,
      enc.rawBytes,
      enc.body.byteLength,
      now,
    );
    if (!row) throw new Error('insertMessage returned no row');
    if (row.refs === 1) {
      const text = blocksToText(msg.blocks);
      if (text.length > 0) this.stmts.insertFts.run(row.id, text);
      // Running totals keep /api/storage off full-table SUMs (bench: 586ms).
      this.stmts.bumpMeta.run('msg_raw_bytes_total', String(enc.rawBytes));
      this.stmts.bumpMeta.run('msg_stored_bytes_total', String(enc.body.byteLength));
    } else {
      this.stmts.bumpMeta.run('dedup_saved_bytes', String(enc.rawBytes));
      this.stmts.bumpMeta.run('dedup_hits', '1');
    }
    return row.id;
  }

  private onStarted(ev: RequestStarted): void {
    this.db.transaction(() => {
      this.stmts.upsertSession.run(
        ev.sessionId,
        ev.ts,
        ev.ts,
        ev.clientName,
        ev.workspace,
        ev.clientSessionId ?? null,
        ev.sessionIdSource ?? 'inferred',
      );

      if (ev.agent) {
        this.stmts.upsertAgent.run(
          ev.agent.agentId,
          ev.sessionId,
          ev.agent.parentAgentId,
          ev.agent.label,
          ev.ts,
          ev.ts,
        );
      }

      const rawMsg: NormalizedMessage = {
        role: 'user',
        blocks: [{ type: 'text', text: ev.request.rawRequestJson }],
        contextSource: 'unknown',
        contextSourceInferred: false,
      };
      const rawId = this.storeMessage(rawMsg, 'raw_request', ev.ts);

      this.stmts.insertRequest.run(
        ev.requestId,
        ev.sessionId,
        ev.ts,
        ev.adapterId,
        ev.provider,
        ev.endpoint,
        ev.method,
        ev.model,
        ev.stream ? 1 : 0,
        ev.request.system.length + ev.request.messages.length,
        ev.redaction.flagged ? 1 : 0,
        JSON.stringify(ev.redaction.hits),
        Buffer.byteLength(ev.request.rawRequestJson, 'utf-8'),
        ev.request.paramsJson,
        JSON.stringify(ev.request.tools),
        rawId,
        ev.agent?.agentId ?? null,
      );

      let seq = 0;
      for (const m of ev.request.system) {
        const id = this.storeMessage(m, 'message', ev.ts);
        this.stmts.linkMessage.run(
          ev.requestId,
          seq++,
          id,
          'system',
          m.contextSource,
          m.contextSourceInferred ? 1 : 0,
        );
      }
      for (const m of ev.request.messages) {
        const id = this.storeMessage(m, 'message', ev.ts);
        this.stmts.linkMessage.run(
          ev.requestId,
          seq++,
          id,
          'input',
          m.contextSource,
          m.contextSourceInferred ? 1 : 0,
        );
        // A tool_result arriving in a later request's input closes the loop
        // on a tool_use we saw go out earlier. Round-trip is inferred timing.
        for (const b of m.blocks) {
          if (b.type === 'tool_result') {
            const open = this.stmts.findToolUse.get(b.toolUseId);
            if (open) {
              const emitterDone = open.latency_ms == null ? null : open.ts + open.latency_ms;
              const rt = emitterDone == null ? null : Math.max(0, ev.ts - emitterDone);
              this.stmts.resolveToolUse.run(
                b.isError ? 1 : 0,
                ev.requestId,
                rt,
                b.toolUseId,
                open.request_id,
              );
            }
          }
        }
      }
    });
  }

  private onToolUse(ev: ToolUseObserved): void {
    this.stmts.upsertToolUse.run(ev.requestId, ev.blockIndex, ev.toolUseId, ev.name, ev.inputJson);
  }

  private onFinished(ev: ResponseFinished): void {
    this.db.transaction(() => {
      if (ev.message) {
        const id = this.storeMessage(ev.message, 'message', ev.ts);
        this.stmts.linkMessage.run(
          ev.requestId,
          1_000_000,
          id,
          'output',
          ev.message.contextSource,
          ev.message.contextSourceInferred ? 1 : 0,
        );
      }
      const u = ev.usage;
      const slot = (x: UsageValue | null): [number | null, string | null] =>
        x == null ? [null, null] : [x.value, x.source];
      const [inTok, inSrc] = slot(u.input);
      const [outTok, outSrc] = slot(u.output);
      const [crTok, crSrc] = slot(u.cacheRead);
      const [cwTok, cwSrc] = slot(u.cacheWrite);

      const toolCount = ev.message
        ? ev.message.blocks.filter((b) => b.type === 'tool_use').length
        : 0;

      // Merge response-side redaction hits with the request-side hits stored
      // at request_started — finishing must never erase what scrubbing found.
      const prior = this.stmts.readHits.get(ev.requestId);
      const merged = new Map<string, number>();
      const priorHits = JSON.parse(prior?.redaction_hits_json ?? '[]') as Array<{
        kind: string;
        count: number;
      }>;
      for (const h of [...priorHits, ...ev.redaction.hits]) {
        merged.set(h.kind, (merged.get(h.kind) ?? 0) + h.count);
      }
      const mergedHits = [...merged.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => a.kind.localeCompare(b.kind));

      this.stmts.finishRequest.run(
        ev.status,
        ev.httpStatus,
        ev.latencyMs,
        ev.ttftMs,
        inTok,
        inSrc,
        outTok,
        outSrc,
        crTok,
        crSrc,
        cwTok,
        cwSrc,
        ev.stopReason,
        ev.error?.type ?? null,
        ev.error?.message ?? null,
        toolCount,
        ev.frameStats.frames,
        ev.frameStats.bytes,
        ev.frameStats.parseErrors,
        ev.redaction.flagged ? 1 : 0,
        JSON.stringify(mergedHits),
        ev.requestId,
      );
      this.stmts.touchSession.run(ev.ts, ev.requestId);
    });
  }

  /**
   * Mark requests left in flight by a previous process as capture_incomplete.
   * Run once at boot, before serving reads.
   */
  reconcileInFlight(): number {
    const r = this.db
      .prepare(`UPDATE requests SET status = 'capture_incomplete' WHERE status IS NULL`)
      .run();
    return r.changes;
  }
}
