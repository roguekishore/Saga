import type { Migration } from './migrate';

/**
 * Schema DDL. `STRICT` on every table; `WITHOUT ROWID` on text-keyed tables.
 * `messages` keeps its integer rowid deliberately: FTS5 needs an integer doc
 * id, and content-hash uniqueness is an index, not the storage key.
 *
 * `messages_fts` is contentless (`content=''`, `contentless_delete=1`): the
 * index holds tokens only — message bodies live once, Brotli-compressed, in
 * `messages.body`. Search returns rowids; snippets are computed after
 * decompressing just the hits. External-content FTS was rejected because it
 * requires plaintext bodies in a real column, which defeats compression;
 * contentless-delete verified available in SQLite 3.53.2 (ground truth
 * 2026-09-03).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE MIGRATION AND NOT FOUR
 *
 * Earlier revisions carried three: `init`, `client-declared-sessions` (which
 * ALTERed sessions and re-stitched the corpus onto wire-stated session ids),
 * and `rename-adapter-ids`. They are folded here into a single `init` because
 * WS-C discards the existing database rather than migrating it — the stale
 * corpus is explicitly not wanted, so a backfill that repairs it has nothing to
 * repair. The final column set is what remains.
 *
 * This is deliberate, not a deletion of history. The runner refuses to proceed
 * when code and database history diverge (`migrate.ts`), so pointing a collector
 * at a pre-WS-C database fails loudly instead of corrupting it. The operator
 * moves `storage/saga.db*` aside; nothing here deletes a database file.
 *
 * ---------------------------------------------------------------------------
 * RESERVED COLUMNS
 *
 * Several columns below are created, indexed where they will be filtered, and
 * left null: `project_id`, `forge_run_id`, and the metric fields CONDUIT will
 * supply over the ingest seam. Reserving them costs nothing now and avoids a
 * migration later — SQLite cannot `ALTER TABLE ... MODIFY COLUMN`, so every
 * change that touches a column is create-copy-drop-rename. Forge in particular
 * is a later layer ABOVE conversation; reserving its two columns means it folds
 * in as display logic rather than a schema change.
 *
 * Do NOT design `project_id` or build Forge grouping against these. The
 * contracts come separately.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init',
    statements: [
      // ---------------------------------------------------------------- sessions
      //
      // A conversation. `session_id_source` is the honesty flag that outranks
      // everything else here: `client-declared` means the client stated its own
      // id on the wire (Claude Code does, on every `/v1/messages`), `inferred`
      // means SAGA guessed from client + workspace/prompt shape and idle time.
      // Wire evidence and a guess must never be presented alike.
      //
      // Session identity is NOT uniform across harnesses and this schema does
      // not pretend otherwise: Codex declares session/thread/turn, Claude Code
      // declares session only, and Gemini-Vertex declares NOTHING session-scoped
      // (SAGA synthesizes a key for it, because SAGA is its reverse proxy and so
      // the only component positioned to stamp one).
      `CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        client_name TEXT,
        workspace TEXT,
        client_session_id TEXT,
        session_id_source TEXT NOT NULL DEFAULT 'inferred',
        -- Enrichment read from the client's own local transcript, keyed on
        -- client_session_id. Null until an enrichment pass fills them.
        title TEXT,
        cwd TEXT,
        git_branch TEXT,
        -- Which capture door and which client. Decides the metrics feed.
        door TEXT,
        harness TEXT,
        -- Harness-declared identity, verbatim off the wire.
        harness_session_id TEXT,
        -- Reserved. Contracts come separately; do not design against these.
        project_id TEXT,
        forge_run_id TEXT
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC)`,
      `CREATE INDEX idx_sessions_client_session ON sessions(client_session_id)
         WHERE client_session_id IS NOT NULL`,
      `CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL`,
      `CREATE INDEX idx_sessions_forge_run ON sessions(forge_run_id) WHERE forge_run_id IS NOT NULL`,

      // ---------------------------------------------------------------- turns
      //
      // One human-typed message and every request it triggered.
      //
      // This is the rung the hierarchy rests on: one human message is NOT one
      // model call. It opens an agentic loop — model calls a tool, harness feeds
      // the result back, repeat until the model answers with no tool call. ~4
      // requests for a small task, 30+ for a large one, each re-shipping the
      // whole growing conversation because the model remembers nothing.
      //
      // `boundary_source` is load-bearing and must not be collapsed away: Codex
      // DECLARES turn boundaries (`client_metadata.turn_id`), so grouping is
      // exact for that harness, while Claude Code and Gemini declare nothing and
      // SAGA infers the boundary from payload structure. A heuristic result
      // mislabeled as declared is worse than no grouping at all.
      //
      // `partial` marks a turn opened by a continuation with no open turn — SAGA
      // restarted mid-loop, or capture began mid-conversation. An honest partial
      // turn beats a fabricated complete one.
      `CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        seq INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        boundary_source TEXT NOT NULL DEFAULT 'inferred',
        harness_turn_id TEXT,
        -- Reserved for subagent folding (Codex states parent_turn_id).
        parent_turn_id TEXT,
        partial INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        request_count INTEGER NOT NULL DEFAULT 0
      ) STRICT, WITHOUT ROWID`,
      `CREATE UNIQUE INDEX idx_turns_session_seq ON turns(session_id, seq)`,
      `CREATE INDEX idx_turns_started ON turns(started_at DESC)`,
      `CREATE INDEX idx_turns_harness_turn ON turns(harness_turn_id)
         WHERE harness_turn_id IS NOT NULL`,

      // ---------------------------------------------------------------- requests
      //
      // One harness→model round-trip.
      //
      // On provenance: the four original token columns each carry their own
      // `_source` because the observer fills them independently off the wire,
      // where any one can be absent. The seam-delivered set arrives as ONE
      // atomic object from ONE feed, so `metrics_source` is a row-level column
      // rather than six near-identical ones — and its enum encodes the two-feed
      // rule directly in the schema.
      //
      // THE TWO-FEED RULE: metrics reach SAGA two ways. Kiro-routed traffic
      // (Claude via Claude Code, Luna via Codex) arrives over the CONDUIT ingest
      // seam on door A. Gemini NEVER passes through CONDUIT — SAGA parses
      // Google's own response natively on door B. So `ingest_received_at` null
      // means "pending" on door A and "will never arrive" on door B, and those
      // must not be confused. `credits` is null on the entire Gemini feed by
      // definition: Vertex bills GCP-side and nothing appears on the wire.
      //
      // `turn_id` has no FK on purpose, matching `agent_id`: turn assignment is
      // a capture-time correlation that can legitimately lag or be revised, and
      // a hard reference would make a late or reordered write fail rather than
      // degrade.
      `CREATE TABLE requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        ts INTEGER NOT NULL,
        adapter_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        model TEXT,
        stream INTEGER NOT NULL,
        status TEXT,
        http_status INTEGER,
        latency_ms REAL,
        ttft_ms REAL,
        input_tokens INTEGER,
        input_tokens_source TEXT,
        output_tokens INTEGER,
        output_tokens_source TEXT,
        cache_read_tokens INTEGER,
        cache_read_tokens_source TEXT,
        cache_write_tokens INTEGER,
        cache_write_tokens_source TEXT,
        -- Reasoning, metered by Kiro as its own line item; also reported by
        -- Gemini as thoughtsTokenCount. Lets the reasoning portion of a tier
        -- be priced independently.
        thought_tokens INTEGER,
        thought_tokens_source TEXT,
        -- Provider-stated total. NOT a SAGA-computed sum, which would be an
        -- estimate wearing a measured field.
        total_tokens INTEGER,
        total_tokens_source TEXT,
        -- Kiro meteringEvent raw credit count. Null on the Gemini feed.
        credits REAL,
        -- Kiro returns this on EVERY response, so one turn yields N readings
        -- that climb as the re-shipped conversation grows. Not a duplicate:
        -- the loop made visible.
        context_usage_percentage REAL,
        -- 'conduit-seam' | 'gemini-native' | null
        metrics_source TEXT,
        ingest_received_at INTEGER,
        stop_reason TEXT,
        error_type TEXT,
        error_message TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        tool_use_count INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT,
        turn_id TEXT,
        -- 'main' | 'subagent' | 'utility' | 'unknown'. Codex DECLARES this
        -- (x-openai-subagent); the others are fingerprinted, and Gemini's Vertex
        -- wire carries nothing that would distinguish them — 'unknown' is a
        -- legitimate answer there, not a failure.
        call_role TEXT,
        call_role_source TEXT,
        call_role_evidence_json TEXT NOT NULL DEFAULT '[]',
        door TEXT NOT NULL DEFAULT 'A',
        harness TEXT,
        -- Cost/latency tier BOTH feeds carry: Codex service_tier
        -- {priority,flex}, Gemini's Vertex request-type header. Identical token
        -- counts can cost and latch differently by tier.
        routing_tier TEXT,
        harness_session_id TEXT,
        harness_thread_id TEXT,
        harness_turn_id TEXT,
        parent_turn_id TEXT,
        -- Reserved.
        forge_run_id TEXT,
        redaction_flagged INTEGER NOT NULL DEFAULT 0,
        redaction_hits_json TEXT NOT NULL DEFAULT '[]',
        frames INTEGER,
        frame_bytes INTEGER,
        frame_parse_errors INTEGER,
        request_bytes INTEGER NOT NULL DEFAULT 0,
        params_json TEXT,
        tools_json TEXT NOT NULL DEFAULT '[]',
        raw_request_msg_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        -- The final Kiro-shaped payload CONDUIT reports sending. Stored as a
        -- deduped, compressed message row like raw_request_msg_id, because the
        -- diff (clean-in ⊖ rewritten-out) IS the injection SAGA renders.
        rewritten_out_msg_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        tier TEXT NOT NULL DEFAULT 'hot'
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX idx_requests_ts ON requests(ts DESC)`,
      `CREATE INDEX idx_requests_session ON requests(session_id, ts)`,
      `CREATE INDEX idx_requests_model ON requests(model) WHERE model IS NOT NULL`,
      `CREATE INDEX idx_requests_agent ON requests(agent_id) WHERE agent_id IS NOT NULL`,
      `CREATE INDEX idx_requests_status_ts ON requests(status, ts DESC)`,
      `CREATE INDEX idx_requests_tier ON requests(tier)`,
      // Retention's message GC anti-joins on this column; without the index
      // it is quadratic over a year corpus (measured: wedged for minutes).
      `CREATE INDEX idx_requests_raw_msg ON requests(raw_request_msg_id) WHERE raw_request_msg_id IS NOT NULL`,
      `CREATE INDEX idx_requests_rewritten_msg ON requests(rewritten_out_msg_id) WHERE rewritten_out_msg_id IS NOT NULL`,
      // The hierarchy read path: a turn's exchanges, in order, bounded by turn
      // rather than scanning the session.
      `CREATE INDEX idx_requests_turn ON requests(turn_id, ts) WHERE turn_id IS NOT NULL`,
      `CREATE INDEX idx_requests_call_role ON requests(call_role) WHERE call_role IS NOT NULL`,
      `CREATE INDEX idx_requests_door_ts ON requests(door, ts DESC)`,
      `CREATE INDEX idx_requests_forge_run ON requests(forge_run_id) WHERE forge_run_id IS NOT NULL`,

      // ---------------------------------------------------------------- stats_daily
      //
      // Daily rollup for year-scale analytics. The W7 bench measured raw
      // GROUP BY over 912k requests at 550-700ms vs a 200ms target; the
      // measured answer is materialized day buckets, not a second engine.
      `CREATE TABLE stats_daily (
        day INTEGER NOT NULL,
        model TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        requests INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        input_sum INTEGER NOT NULL,
        output_sum INTEGER NOT NULL,
        in_sources TEXT NOT NULL,
        out_sources TEXT NOT NULL,
        latency_sum REAL NOT NULL,
        latency_count INTEGER NOT NULL,
        ttft_sum REAL NOT NULL,
        ttft_count INTEGER NOT NULL,
        PRIMARY KEY (day, model, adapter_id)
      ) STRICT, WITHOUT ROWID`,

      // ---------------------------------------------------------------- messages
      //
      // `kind` carries 'rewritten_request' alongside 'raw_request' so CONDUIT's
      // rewritten-out payload reuses dedup and compression instead of getting a
      // parallel storage path.
      `CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message','raw_request','rewritten_request')),
        body BLOB NOT NULL,
        compressed INTEGER NOT NULL,
        raw_bytes INTEGER NOT NULL,
        stored_bytes INTEGER NOT NULL,
        refs INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      ) STRICT`,

      `CREATE TABLE request_messages (
        request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        message_id INTEGER NOT NULL REFERENCES messages(id),
        segment TEXT NOT NULL CHECK (segment IN ('system','input','output')),
        context_source TEXT NOT NULL,
        context_source_inferred INTEGER NOT NULL,
        PRIMARY KEY (request_id, seq)
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX idx_request_messages_msg ON request_messages(message_id)`,

      `CREATE TABLE tool_uses (
        request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
        block_index INTEGER NOT NULL,
        tool_use_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input_json TEXT,
        result_observed INTEGER NOT NULL DEFAULT 0,
        result_is_error INTEGER,
        result_request_id TEXT,
        round_trip_ms REAL,
        PRIMARY KEY (request_id, block_index)
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX idx_tool_uses_name ON tool_uses(name)`,
      `CREATE INDEX idx_tool_uses_id ON tool_uses(tool_use_id)`,

      // ---------------------------------------------------------------- injections
      //
      // Context injections surfaced as tags — SAGA's original purpose, at the
      // granularity of a single instruction.
      //
      // Two sources, and the difference is visible to the reader:
      //  - 'saga-observed'    present on the front door before any gateway, so
      //                       SAGA saw it directly (Codex user_instructions,
      //                       Gemini session_context).
      //  - 'conduit-declared' CONDUIT reports what it added. SAGA sits on the
      //                       wrong side of that rewrite and cannot see it, so
      //                       it displays what CONDUIT declares. This is the
      //                       blind-spot fix.
      `CREATE TABLE injections (
        request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        location TEXT,
        source TEXT NOT NULL CHECK (source IN ('saga-observed','conduit-declared')),
        detail TEXT,
        PRIMARY KEY (request_id, seq)
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX idx_injections_type ON injections(type)`,

      // ---------------------------------------------------------------- reasoning_blocks
      //
      // Kiro carries a `modelId` per reasoning block, so a turn's reasoning can
      // be attributed to the model that produced it. `signature_present` records
      // whether the block was signed without storing the signature itself.
      `CREATE TABLE reasoning_blocks (
        request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
        block_index INTEGER NOT NULL,
        model_id TEXT,
        signature_present INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (request_id, block_index)
      ) STRICT, WITHOUT ROWID`,

      `CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        parent_agent_id TEXT,
        label TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID`,

      `CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='', contentless_delete=1)`,

      `CREATE TABLE meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      ) STRICT, WITHOUT ROWID`,
    ],
  },
];
