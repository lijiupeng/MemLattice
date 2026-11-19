-- SQLite 全量建表（等价于 PG 侧 001…010 的最终态）。
-- 单机部署从零建库，因此不再保留增量迁移；PG 侧的迁移链继续独立演进。
-- 时间统一存 ISO 文本（strftime 默认值与 JS toISOString 对齐），布尔存 0/1，
-- 数组与 jsonb 统一存 JSON 文本，由驱动按列名还原。

CREATE TABLE IF NOT EXISTS app_user (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id  TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS mem_block (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  label        TEXT NOT NULL CHECK (label IN ('persona','rules','skills')),
  slot         TEXT NOT NULL DEFAULT 'default',
  content      TEXT NOT NULL DEFAULT '',
  summary      TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0,
  char_limit   INTEGER NOT NULL DEFAULT 2200,
  read_only    INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','promoted','agent')),
  heat         REAL NOT NULL DEFAULT 0,
  heat_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  ref_terms    TEXT NOT NULL DEFAULT '[]',
  ref_cards    TEXT NOT NULL DEFAULT '[]',
  pinned       INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,
  CONSTRAINT mem_block_content_within_limit CHECK (length(content) <= char_limit),
  CONSTRAINT mem_block_summary_len CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_block_slot_uniq
  ON mem_block (user_id, label, slot) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mem_block_user ON mem_block (user_id, label) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mem_block_heat ON mem_block (user_id, heat DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS term (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('entity','intent','concept')),
  aliases     TEXT NOT NULL DEFAULT '[]',
  df          INTEGER NOT NULL DEFAULT 0,
  heat        REAL NOT NULL DEFAULT 0,
  heat_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_hit_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS term_name_uniq ON term (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS term_heat ON term (user_id, heat DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS term_edge (
  src_id     INTEGER NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  dst_id     INTEGER NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('co_occur','isa','alias','related')),
  weight     REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (src_id, dst_id, type),
  CONSTRAINT term_edge_no_self CHECK (src_id <> dst_id)
);
CREATE INDEX IF NOT EXISTS term_edge_dst ON term_edge (dst_id);

CREATE TABLE IF NOT EXISTS mem_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_id TEXT,
  title      TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at   TEXT
);
CREATE INDEX IF NOT EXISTS mem_event_user_time ON mem_event (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mem_card (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL UNIQUE REFERENCES mem_event(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  summary      TEXT NOT NULL,
  intent       TEXT,
  keywords     TEXT NOT NULL DEFAULT '[]',
  entities     TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'ready',
  source       TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','external','system')),
  category     TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','person')),
  importance   REAL NOT NULL DEFAULT 0.5,
  confidence   REAL NOT NULL DEFAULT 0.8,
  use_count    INTEGER NOT NULL DEFAULT 0,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  heat         REAL NOT NULL DEFAULT 0,
  heat_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  last_hit_at  TEXT,
  stale_at     TEXT,
  is_skeleton  INTEGER NOT NULL DEFAULT 0,
  skeleton_at  TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,
  CONSTRAINT mem_card_summary_len CHECK (length(summary) BETWEEN 40 AND 600)
);
CREATE INDEX IF NOT EXISTS mem_card_time ON mem_card (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mem_card_heat ON mem_card (user_id, heat DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS card_term (
  card_id INTEGER NOT NULL REFERENCES mem_card(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'keyword' CHECK (role IN ('subject','intent','keyword','entity')),
  weight  REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (card_id, term_id, role)
);
CREATE INDEX IF NOT EXISTS card_term_term ON card_term (term_id, weight DESC);

CREATE TABLE IF NOT EXISTS mem_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  tool_name   TEXT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  hash        BLOB,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS mem_raw_event_seq ON mem_raw (event_id, seq);
CREATE INDEX IF NOT EXISTS mem_raw_user_ts ON mem_raw (user_id, ts DESC);

CREATE TABLE IF NOT EXISTS card_raw (
  card_id INTEGER NOT NULL REFERENCES mem_card(id) ON DELETE CASCADE,
  raw_id  INTEGER NOT NULL,
  weight  REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (card_id, raw_id)
);
CREATE INDEX IF NOT EXISTS card_raw_raw ON card_raw (raw_id);

CREATE TABLE IF NOT EXISTS promotion_candidate (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('skill','rule','alias','merge','block')),
  payload     TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '[]',
  score       REAL NOT NULL DEFAULT 0,
  dedupe_key  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_candidate_dedupe
  ON promotion_candidate (user_id, kind, dedupe_key) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS mem_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  object_type TEXT NOT NULL,
  object_id   INTEGER NOT NULL,
  op          TEXT NOT NULL,
  before      TEXT,
  after       TEXT,
  actor       TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS mem_audit_obj ON mem_audit (object_type, object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mem_audit_time ON mem_audit (created_at DESC);

CREATE TABLE IF NOT EXISTS mem_version (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL,
  object_id   INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (object_type, object_id, version)
);

CREATE TABLE IF NOT EXISTS mem_trash (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  object_id   INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,
  deleted_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  purge_at    TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX IF NOT EXISTS mem_trash_purge ON mem_trash (purge_at) WHERE restored_at IS NULL;

CREATE TABLE IF NOT EXISTS condense_job (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL UNIQUE,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_error TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS condense_job_due ON condense_job (next_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS mem_injection (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  query         TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'all',
  budget_limit  INTEGER NOT NULL,
  budget_used   INTEGER NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  blocks        TEXT NOT NULL DEFAULT '[]',
  cards         TEXT NOT NULL DEFAULT '[]',
  hints         TEXT NOT NULL DEFAULT '[]',
  dropped       TEXT NOT NULL DEFAULT '[]',
  dropped_count INTEGER NOT NULL DEFAULT 0,
  elapsed_ms    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS mem_injection_recent ON mem_injection (user_id, id DESC);

CREATE TABLE IF NOT EXISTS app_setting (
  user_id    INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'human',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, key)
);

-- 整理清单里判断过、决定不处理的项：不记下来，下次睡觉还要重新看同一批
CREATE TABLE IF NOT EXISTS mem_triage (
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (object_type IN ('raw', 'term', 'card')),
  object_id   INTEGER NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, object_type, object_id)
);
