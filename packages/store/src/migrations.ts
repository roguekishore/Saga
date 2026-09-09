import type { Migration } from './migrate';

/**
 * Schema DDL. `STRICT` on every table; `WITHOUT ROWID` on text-keyed tables.
 * `messages` keeps its integer rowid deliberately: FTS5 needs an integer doc
 * id, and content-hash uniqueness is an index, not the storage key.
 *
 * `messages_fts` is contentless (`content=''`, `contentless_delete=1`): the
 * index holds tokens only — message bodies live once, Brotli-compressed, in
 * `messages.body`. Search returns rowids; snippets are computed after
 * decompressing just the hits. This deviates from the example commit message
 * in the brief (external-content FTS) because external content requires
 * plaintext bodies in a real column, which defeats compression; verified
 * available in SQLite 3.53.2 (ground truth 2026-09-03).
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init',
    statements: [
      `CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        client_name TEXT,
        workspace TEXT
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC)`,

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
        stop_reason TEXT,
        error_type TEXT,
        error_message TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        tool_use_count INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT,
        redaction_flagged INTEGER NOT NULL DEFAULT 0,
        redaction_hits_json TEXT NOT NULL DEFAULT '[]',
        frames INTEGER,
        frame_bytes INTEGER,
        frame_parse_errors INTEGER,
        request_bytes INTEGER NOT NULL DEFAULT 0,
        params_json TEXT,
        tools_json TEXT NOT NULL DEFAULT '[]',
        raw_request_msg_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
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

      `CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message','raw_request')),
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

  /**
   * Sessions become wire-stated where the client states them, and the existing
   * corpus is re-stitched to match.
   *
   * The bug being repaired: session identity was keyed on the system-prompt
   * fingerprint, so one Claude Code conversation shattered into a session per
   * model and per subagent (measured 2026-09-04: one conversation split 7 ways,
   * another 4), while two conversations in different projects could MERGE
   * whenever their prompt heads collided — `client_name` was 'cli' for both and
   * `workspace` was null on 27 of 28 rows. Agent correlation was collateral
   * damage: fingerprint had already been spent on the session, so every session
   * held exactly one agent (30 agents, all labeled 'main', zero parent edges).
   *
   * The fix is a swap, not a rewrite: `metadata.user_id.session_id` — present
   * on every Claude Code `/v1/messages` call and already captured in
   * `params_json` — bounds the session, and the fingerprint goes back to its
   * real job of separating agents INSIDE one.
   *
   * The backfill is driven off `requests`, not off old `sessions` rows, because
   * the old key erred in both directions: some old sessions must split, not
   * merely merge. Statement order is load-bearing under immediate FK
   * enforcement — new parents exist, then children move, then empty parents go.
   */
  {
    id: 2,
    name: 'client-declared-sessions',
    statements: [
      `ALTER TABLE sessions ADD COLUMN client_session_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN session_id_source TEXT NOT NULL DEFAULT 'inferred'`,
      // Enrichment read from the client's own local transcript, keyed on
      // client_session_id. Null until an enrichment pass fills them.
      `ALTER TABLE sessions ADD COLUMN title TEXT`,
      `ALTER TABLE sessions ADD COLUMN cwd TEXT`,
      `ALTER TABLE sessions ADD COLUMN git_branch TEXT`,
      `CREATE INDEX idx_sessions_client_session ON sessions(client_session_id)
         WHERE client_session_id IS NOT NULL`,

      // One row per request that carries a stated session id, with the old and
      // new session ids side by side. Temp so it vanishes with the connection.
      `CREATE TEMP TABLE _remap AS
         SELECT r.request_id AS request_id,
                r.session_id AS old_session_id,
                json_extract(json_extract(r.params_json, '$.metadata.user_id'), '$.session_id') AS cc,
                'ses_' || json_extract(json_extract(r.params_json, '$.metadata.user_id'), '$.session_id') AS new_session_id
           FROM requests r
          WHERE json_extract(json_extract(r.params_json, '$.metadata.user_id'), '$.session_id') IS NOT NULL`,

      // Carry client_name/workspace over from the old session of the EARLIEST
      // request in each new session, rather than inventing values.
      `INSERT INTO sessions (session_id, started_at, last_activity_at, client_name, workspace,
                             client_session_id, session_id_source)
         SELECT m.new_session_id,
                MIN(r.ts), MAX(r.ts),
                (SELECT s2.client_name FROM _remap m2
                   JOIN requests r2 ON r2.request_id = m2.request_id
                   JOIN sessions s2 ON s2.session_id = m2.old_session_id
                  WHERE m2.new_session_id = m.new_session_id
                  ORDER BY r2.ts LIMIT 1),
                (SELECT s2.workspace FROM _remap m2
                   JOIN requests r2 ON r2.request_id = m2.request_id
                   JOIN sessions s2 ON s2.session_id = m2.old_session_id
                  WHERE m2.new_session_id = m.new_session_id
                  ORDER BY r2.ts LIMIT 1),
                m.cc, 'client-declared'
           FROM _remap m JOIN requests r ON r.request_id = m.request_id
          GROUP BY m.new_session_id
         ON CONFLICT(session_id) DO NOTHING`,

      `UPDATE requests
          SET session_id = (SELECT new_session_id FROM _remap WHERE _remap.request_id = requests.request_id)
        WHERE request_id IN (SELECT request_id FROM _remap)`,

      // An agent follows its requests. `requests.agent_id` has no FK, so this
      // is ordered by ts rather than relying on referential integrity.
      `UPDATE agents
          SET session_id = (SELECT r.session_id FROM requests r
                             WHERE r.agent_id = agents.agent_id ORDER BY r.ts LIMIT 1)
        WHERE EXISTS (SELECT 1 FROM requests r WHERE r.agent_id = agents.agent_id)`,

      // Old inferred sessions that everything moved off of. Only ever empty
      // ones, and only inferred: a client-declared row is never dropped here.
      `DELETE FROM sessions
        WHERE session_id_source = 'inferred'
          AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.session_id = sessions.session_id)
          AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.session_id = sessions.session_id)`,

      // Every historical agent was labeled 'main' because each old session held
      // exactly one. Now that they share a session, the earliest keeps 'main'
      // and the rest get ordinals — a position, not an invented role name.
      `UPDATE agents
          SET label = 'agent-' || (SELECT COUNT(*) FROM agents a2
                                    WHERE a2.session_id = agents.session_id
                                      AND a2.first_seen_at < agents.first_seen_at)
        WHERE label = 'main'
          AND EXISTS (SELECT 1 FROM agents a3
                       WHERE a3.session_id = agents.session_id
                         AND a3.first_seen_at < agents.first_seen_at)`,

      /**
       * Scrub the historical device fingerprint. `device_id` is a stable
       * machine identifier that cleared every net in the redact layer — the
       * entropy backstop only flags hex at 96+ chars and this is 64 — so it
       * stored in the clear. The live path now catches it by pattern; this
       * catches what is already on disk.
       *
       * The `'' ||` is load-bearing: `json_set` returns a value carrying
       * SQLite's JSON subtype, and nesting it directly would rewrite
       * `metadata.user_id` from a JSON *string* into an object, so backfilled
       * rows would no longer match the shape live capture writes (and `CAST(…
       * AS TEXT)` does not clear the subtype). Concatenation does.
       */
      `UPDATE requests
          SET params_json = json_set(params_json, '$.metadata.user_id',
                ('' || json_set(json_extract(params_json, '$.metadata.user_id'),
                                '$.device_id', '[REDACTED:device-fingerprint:historical]')))
        WHERE json_extract(json_extract(params_json, '$.metadata.user_id'), '$.device_id') IS NOT NULL`,

      `DROP TABLE _remap`,
    ],
  },

  {
    id: 3,
    name: 'rename-adapter-ids',
    statements: [
      `UPDATE requests SET adapter_id = 'anthropic' WHERE adapter_id = 'kiro-anthropic'`,
      `UPDATE requests SET adapter_id = 'openai' WHERE adapter_id = 'kiro-openai'`,
    ],
  },
];
