import {
  blocksToText,
  type ConduitIngest,
  type Logger,
  type NormalizedEvent,
  type NormalizedMessage,
  noopLogger,
  type Provenance,
  provenanceRank,
  type RequestStarted,
  type ResponseFinished,
  type ToolUseObserved,
  type UsageValue,
} from '@saga/contracts';
import { encodeBody, sha256hex } from './codec';
import type { Driver, Statement } from './driver';

/** The six token figures plus their provenance, as stored. */
interface MetricRow {
  /** Read back rather than carried on the event: the request row owns it. */
  door: string | null;
  input_tokens: number | null;
  input_tokens_source: string | null;
  output_tokens: number | null;
  output_tokens_source: string | null;
  cache_read_tokens: number | null;
  cache_read_tokens_source: string | null;
  cache_write_tokens: number | null;
  cache_write_tokens_source: string | null;
  thought_tokens: number | null;
  thought_tokens_source: string | null;
  total_tokens: number | null;
  total_tokens_source: string | null;
  ingest_received_at: number | null;
}

type Slot = [number | null, string | null];

/**
 * Pick between a stored figure and an arriving one BY PROVENANCE RANK, never by
 * arrival order.
 *
 * This is the crux of the two-feed design. On door A two writers touch these
 * same columns: the stream observer, which reads CONDUIT's client-facing
 * response and therefore sees CONDUIT's *estimates* (`gateway-computed`), and
 * the ingest seam, which carries figures CONDUIT parsed from Kiro's own
 * metadataEvent/meteringEvent (`upstream-reported`). Either can land first.
 *
 * "Last write wins" would therefore discard the real numbers roughly half the
 * time — the exact failure this measurement apparatus exists to prevent. Ranking
 * makes the outcome independent of ordering.
 *
 * Ties keep the incumbent: a same-provenance re-report carries no new
 * information, which also makes a duplicate emit idempotent.
 */
function pickBySource(
  stored: number | null,
  storedSource: string | null,
  arriving: number | null,
  arrivingSource: Provenance,
): Slot {
  if (arriving == null) return [stored, storedSource];
  if (stored == null || storedSource == null) return [arriving, arrivingSource];
  const storedRank = provenanceRank(storedSource as Provenance) ?? 0;
  return provenanceRank(arrivingSource) > storedRank
    ? [arriving, arrivingSource]
    : [stored, storedSource];
}

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
    upsertTurn: Statement;
    bumpTurn: Statement;
    touchTurnEnd: Statement;
    insertInjection: Statement;
    insertReasoningBlock: Statement;
    readMetrics: Statement<MetricRow>;
    applySeamMetrics: Statement;
    setRewrittenOut: Statement;
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
                               client_session_id, session_id_source, door, harness,
                               harness_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             THEN 'client-declared' ELSE sessions.session_id_source END,
           -- First writer wins on door/harness: a session belongs to the door it
           -- arrived on, and a later 'unknown' must not erase a real detection.
           door = COALESCE(sessions.door, excluded.door),
           harness = CASE
             WHEN sessions.harness IS NULL OR sessions.harness = 'unknown'
             THEN excluded.harness ELSE sessions.harness END,
           harness_session_id = COALESCE(sessions.harness_session_id, excluded.harness_session_id)`,
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
          tools_json, raw_request_msg_id, agent_id,
          turn_id, call_role, call_role_source, call_role_evidence_json,
          door, harness, routing_tier,
          harness_session_id, harness_thread_id, harness_turn_id, parent_turn_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

      // A turn is created by the request that opened it; later requests in the
      // same loop only bump the counter. DO NOTHING rather than an update: the
      // opening request's classification is the turn's identity, and a
      // continuation must never rewrite the boundary that was already decided.
      upsertTurn: db.prepare(
        `INSERT INTO turns (turn_id, session_id, seq, started_at, boundary_source,
                            harness_turn_id, parent_turn_id, partial, evidence_json, request_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(turn_id) DO NOTHING`,
      ),
      bumpTurn: db.prepare('UPDATE turns SET request_count = request_count + 1 WHERE turn_id = ?'),
      // Last observed activity, not a closing boundary — nothing on the wire
      // declares an instruction finished. MAX() keeps it monotonic when
      // responses finish out of order.
      touchTurnEnd: db.prepare(
        `UPDATE turns SET ended_at = MAX(COALESCE(ended_at, 0), ?)
          WHERE turn_id = (SELECT turn_id FROM requests WHERE request_id = ?)`,
      ),

      insertInjection: db.prepare(
        `INSERT INTO injections (request_id, seq, type, location, source, detail)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id, seq) DO NOTHING`,
      ),
      insertReasoningBlock: db.prepare(
        `INSERT INTO reasoning_blocks (request_id, block_index, model_id, signature_present)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(request_id, block_index) DO UPDATE SET
           model_id = COALESCE(excluded.model_id, reasoning_blocks.model_id),
           signature_present = MAX(reasoning_blocks.signature_present, excluded.signature_present)`,
      ),

      // Read the incumbent figures and their provenance so the merge can rank
      // them in JS. Doing it there rather than in SQL keeps the comparison
      // testable and keeps the ladder in one place (`provenanceRank`), instead
      // of duplicating it across six CASE expressions.
      readMetrics: db.prepare(
        `SELECT door,
                input_tokens, input_tokens_source,
                output_tokens, output_tokens_source,
                cache_read_tokens, cache_read_tokens_source,
                cache_write_tokens, cache_write_tokens_source,
                thought_tokens, thought_tokens_source,
                total_tokens, total_tokens_source,
                ingest_received_at
           FROM requests WHERE request_id = ?`,
      ),
      applySeamMetrics: db.prepare(
        `UPDATE requests SET
          input_tokens = ?, input_tokens_source = ?,
          output_tokens = ?, output_tokens_source = ?,
          cache_read_tokens = ?, cache_read_tokens_source = ?,
          cache_write_tokens = ?, cache_write_tokens_source = ?,
          thought_tokens = ?, thought_tokens_source = ?,
          total_tokens = ?, total_tokens_source = ?,
          credits = COALESCE(?, credits),
          context_usage_percentage = COALESCE(?, context_usage_percentage),
          stop_reason = COALESCE(stop_reason, ?),
          metrics_source = ?,
          ingest_received_at = ?
         WHERE request_id = ?`,
      ),
      setRewrittenOut: db.prepare(
        'UPDATE requests SET rewritten_out_msg_id = ? WHERE request_id = ?',
      ),
      finishRequest: db.prepare(
        `UPDATE requests SET
          status = ?, http_status = ?, latency_ms = ?, ttft_ms = COALESCE(?, ttft_ms),
          input_tokens = ?, input_tokens_source = ?,
          output_tokens = ?, output_tokens_source = ?,
          cache_read_tokens = ?, cache_read_tokens_source = ?,
          cache_write_tokens = ?, cache_write_tokens_source = ?,
          thought_tokens = ?, thought_tokens_source = ?,
          total_tokens = ?, total_tokens_source = ?,
          -- The seam may have already supplied a real Kiro figure; the observer
          -- has no credit number of its own, so never overwrite one with null.
          stop_reason = COALESCE(?, stop_reason),
          error_type = ?, error_message = ?,
          tool_use_count = ?, frames = ?, frame_bytes = ?, frame_parse_errors = ?,
          redaction_flagged = MAX(redaction_flagged, ?),
          redaction_hits_json = ?,
          -- Only claim a native-parse feed when nothing better already wrote one.
          metrics_source = COALESCE(metrics_source, ?)
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
        case 'conduit_ingest':
          this.onConduitIngest(ev);
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

  /**
   * Insert-or-ref a deduplicated message. Returns the message row id.
   *
   * `rewritten_request` reuses this path deliberately: CONDUIT's rewritten-out
   * payload is large, highly repetitive across a turn (the same system prompt and
   * tool specs re-shipped every round-trip), and therefore exactly what dedup and
   * compression are for. A parallel storage path would forgo both.
   */
  private storeMessage(
    msg: NormalizedMessage,
    kind: 'message' | 'raw_request' | 'rewritten_request',
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
        ev.door ?? 'A',
        ev.harness ?? 'unknown',
        ev.harnessIdentity?.sessionId ?? null,
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

      // The turn row must exist before the request references it. `turn_id`
      // carries no FK (see the schema note), but ordering it this way keeps the
      // reference valid anyway rather than relying on that.
      if (ev.turn) {
        this.stmts.upsertTurn.run(
          ev.turn.turnId,
          ev.sessionId,
          ev.turn.seq,
          ev.ts,
          ev.turn.source,
          ev.turn.harnessTurnId,
          ev.harnessIdentity?.parentTurnId ?? null,
          ev.turn.partial ? 1 : 0,
          JSON.stringify(ev.turn.evidence),
        );
        this.stmts.bumpTurn.run(ev.turn.turnId);
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
        ev.turn?.turnId ?? null,
        ev.callRole?.role ?? null,
        ev.callRole?.source ?? null,
        JSON.stringify(ev.callRole?.evidence ?? []),
        ev.door ?? 'A',
        ev.harness ?? null,
        ev.routingTier ?? null,
        ev.harnessIdentity?.sessionId ?? null,
        ev.harnessIdentity?.threadId ?? null,
        ev.harnessIdentity?.turnId ?? null,
        ev.harnessIdentity?.parentTurnId ?? null,
      );

      // Injections SAGA saw itself on the front door. CONDUIT's self-declared
      // ones arrive later over the seam and are appended with their own seq
      // range, so the two sources never overwrite each other.
      let injSeq = 0;
      for (const inj of ev.injections ?? []) {
        this.stmts.insertInjection.run(
          ev.requestId,
          injSeq++,
          inj.type,
          inj.location,
          inj.source,
          inj.detail,
        );
      }

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

  /**
   * Base seq for CONDUIT-declared injections.
   *
   * FIXED, not appended after whatever is already there, and that is the whole
   * idempotency story for this table: a computed offset would place a duplicate
   * emit's tags at fresh seqs, so `ON CONFLICT DO NOTHING` would never fire and
   * the tags would double. A fixed base means a retry writes the same primary
   * keys and is discarded. Same trick as the 1_000_000 seq for output messages.
   */
  private static readonly CONDUIT_INJECTION_SEQ_BASE = 10_000;

  /**
   * The CONDUIT seam: real metrics + the rewritten-out payload, joined to the
   * clean-in row SAGA already stored.
   *
   * Everything here is already redacted — the ingest endpoint scrubs before
   * pushing, because this payload carries a full system prompt, history, and tool
   * specs, the same material the proxy scrubs on the front door.
   */
  private onConduitIngest(ev: ConduitIngest): void {
    const { payload } = ev;
    const prior = this.stmts.readMetrics.get(payload.request_id);

    // A payload for a request SAGA never stored: it restarted, or capture began
    // after the request went out. Expected, not exceptional — count it and move
    // on. Throwing here would take down the queue consumer for a routine race.
    if (!prior) {
      this.stmts.bumpMeta.run('ingest_unmatched', '1');
      this.log.log(
        'warn',
        'store',
        `conduit ingest for unknown request ${payload.request_id} (dropped)`,
      );
      return;
    }

    const duplicate = prior.ingest_received_at != null;
    if (duplicate) this.stmts.bumpMeta.run('ingest_duplicate', '1');

    this.db.transaction(() => {
      const m = payload.metrics;
      if (m) {
        // Kiro IS the provider on door A, so figures CONDUIT parsed from its
        // metadataEvent/meteringEvent are upstream-reported — and therefore
        // outrank the observer's gateway-computed estimates regardless of which
        // landed first.
        const src: Provenance = 'upstream-reported';
        const [inTok, inSrc] = pickBySource(
          prior.input_tokens,
          prior.input_tokens_source,
          m.input_tokens,
          src,
        );
        const [outTok, outSrc] = pickBySource(
          prior.output_tokens,
          prior.output_tokens_source,
          m.output_tokens,
          src,
        );
        const [crTok, crSrc] = pickBySource(
          prior.cache_read_tokens,
          prior.cache_read_tokens_source,
          m.cache_read_tokens,
          src,
        );
        const [cwTok, cwSrc] = pickBySource(
          prior.cache_write_tokens,
          prior.cache_write_tokens_source,
          m.cache_write_tokens,
          src,
        );
        const [thTok, thSrc] = pickBySource(
          prior.thought_tokens,
          prior.thought_tokens_source,
          m.thought_tokens,
          src,
        );
        const [totTok, totSrc] = pickBySource(
          prior.total_tokens,
          prior.total_tokens_source,
          m.total_tokens,
          src,
        );

        this.stmts.applySeamMetrics.run(
          inTok,
          inSrc,
          outTok,
          outSrc,
          crTok,
          crSrc,
          cwTok,
          cwSrc,
          thTok,
          thSrc,
          totTok,
          totSrc,
          // Assignment, not increment — so a duplicate emit cannot inflate it.
          m.credits,
          m.context_usage_percentage,
          m.stop_reason,
          'conduit-seam',
          ev.ts,
          payload.request_id,
        );

        m.reasoning_blocks.forEach((rb, i) => {
          this.stmts.insertReasoningBlock.run(
            payload.request_id,
            i,
            rb.model_id,
            rb.signature_present ? 1 : 0,
          );
        });
      }

      if (ev.rewrittenOutJson) {
        const msg: NormalizedMessage = {
          role: 'user',
          blocks: [{ type: 'text', text: ev.rewrittenOutJson }],
          contextSource: 'unknown',
          contextSourceInferred: false,
        };
        const id = this.storeMessage(msg, 'rewritten_request', ev.ts);
        this.stmts.setRewrittenOut.run(id, payload.request_id);
      }

      // What CONDUIT says it added. SAGA sits on the wrong side of the rewrite
      // and cannot observe it, so it records the declaration and labels it as
      // such — distinguishable in the UI from what SAGA saw itself.
      const base = StoreWriter.CONDUIT_INJECTION_SEQ_BASE;
      (payload.rewritten_out?.injections ?? []).forEach((inj, i) => {
        this.stmts.insertInjection.run(
          payload.request_id,
          base + i,
          inj.type,
          inj.location,
          'conduit-declared',
          null,
        );
      });
    });
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
      // Rank against whatever is already stored instead of overwriting it. The
      // seam can land BEFORE the observer finishes (CONDUIT parses Kiro's stream
      // while the client is still reading the response), and a blind write here
      // would replace real upstream-reported Kiro figures with the observer's
      // gateway-computed estimates. Same ladder, opposite direction.
      const prior = this.stmts.readMetrics.get(ev.requestId);
      const merge = (
        stored: number | null,
        storedSrc: string | null,
        arriving: UsageValue | null | undefined,
      ): Slot =>
        arriving == null
          ? [stored, storedSrc]
          : pickBySource(stored, storedSrc, arriving.value, arriving.source);

      const [inTok, inSrc] = merge(
        prior?.input_tokens ?? null,
        prior?.input_tokens_source ?? null,
        u.input,
      );
      const [outTok, outSrc] = merge(
        prior?.output_tokens ?? null,
        prior?.output_tokens_source ?? null,
        u.output,
      );
      const [crTok, crSrc] = merge(
        prior?.cache_read_tokens ?? null,
        prior?.cache_read_tokens_source ?? null,
        u.cacheRead,
      );
      const [cwTok, cwSrc] = merge(
        prior?.cache_write_tokens ?? null,
        prior?.cache_write_tokens_source ?? null,
        u.cacheWrite,
      );
      const [thTok, thSrc] = merge(
        prior?.thought_tokens ?? null,
        prior?.thought_tokens_source ?? null,
        u.thought,
      );
      const [totTok, totSrc] = merge(
        prior?.total_tokens ?? null,
        prior?.total_tokens_source ?? null,
        u.total,
      );

      // Door B IS the provider hop, so a native parse there is a real feed and
      // says so. On door A the observer only ever sees CONDUIT's estimates, so
      // `metrics_source` stays null until the seam supplies the real figures —
      // which is what lets the read layer tell "pending" from "not applicable".
      const nativeFeed = (prior?.door ?? 'A') === 'B' ? 'gemini-native' : null;

      const toolCount = ev.message
        ? ev.message.blocks.filter((b) => b.type === 'tool_use').length
        : 0;

      // Merge response-side redaction hits with the request-side hits stored
      // at request_started — finishing must never erase what scrubbing found.
      const hitsRow = this.stmts.readHits.get(ev.requestId);
      const merged = new Map<string, number>();
      const priorHits = JSON.parse(hitsRow?.redaction_hits_json ?? '[]') as Array<{
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
        thTok,
        thSrc,
        totTok,
        totSrc,
        ev.stopReason,
        ev.error?.type ?? null,
        ev.error?.message ?? null,
        toolCount,
        ev.frameStats.frames,
        ev.frameStats.bytes,
        ev.frameStats.parseErrors,
        ev.redaction.flagged ? 1 : 0,
        JSON.stringify(mergedHits),
        nativeFeed,
        ev.requestId,
      );
      // Last observed activity on the turn, so a turn's span reflects when its
      // loop actually went quiet rather than when its first request went out.
      this.stmts.touchTurnEnd.run(ev.ts, ev.requestId);
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
