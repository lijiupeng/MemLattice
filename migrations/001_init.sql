-- MemLattice 001_init
-- 单一真相源：所有记忆只存在 PostgreSQL 一份。图是索引，不是第二份数据。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- pgvector 可选：不可用时 embedding 能力降级（仅关键词召回），不影响其余功能。
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector unavailable: embedding disabled, keyword-only recall remains';
  END;
END $$;

-- ---------------------------------------------------------------- 用户
CREATE TABLE IF NOT EXISTS app_user (
  id           bigserial PRIMARY KEY,
  external_id  text NOT NULL UNIQUE,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- L1 常驻块
CREATE TABLE IF NOT EXISTS mem_block (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  label        text NOT NULL CHECK (label IN ('persona','rules','skills','recent')),
  slot         text NOT NULL DEFAULT 'default',
  content      text NOT NULL DEFAULT '',
  char_limit   int  NOT NULL DEFAULT 2000,
  read_only    boolean NOT NULL DEFAULT false,
  source       text NOT NULL DEFAULT 'human' CHECK (source IN ('human','promoted')),
  heat         real NOT NULL DEFAULT 0,
  heat_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  ref_terms    bigint[] NOT NULL DEFAULT '{}',
  ref_cards    bigint[] NOT NULL DEFAULT '{}',
  pinned       boolean NOT NULL DEFAULT false,
  version      int  NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  -- FR-01：超限写入必须失败，不得静默截断。硬上限落在数据库层。
  CONSTRAINT mem_block_content_within_limit CHECK (char_length(content) <= char_limit)
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_block_slot_uniq
  ON mem_block (user_id, label, slot) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mem_block_user ON mem_block (user_id, label) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mem_block_heat ON mem_block (user_id, heat DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- 词节点
CREATE TABLE IF NOT EXISTS term (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('entity','intent','concept')),
  aliases    text[] NOT NULL DEFAULT '{}',
  df         int NOT NULL DEFAULT 0,
  heat       real NOT NULL DEFAULT 0,
  heat_at    timestamptz NOT NULL DEFAULT now(),
  last_hit_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS term_name_uniq ON term (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS term_aliases_gin ON term USING gin (aliases);
CREATE INDEX IF NOT EXISTS term_name_trgm  ON term USING gin (lower(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS term_heat ON term (user_id, heat DESC) WHERE deleted_at IS NULL;

-- 词间边（自关联多对多）
CREATE TABLE IF NOT EXISTS term_edge (
  src_id     bigint NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  dst_id     bigint NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('co_occur','isa','alias','related')),
  weight     real NOT NULL DEFAULT 1.0 CHECK (weight > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (src_id, dst_id, type),
  CONSTRAINT term_edge_no_self CHECK (src_id <> dst_id)
);
CREATE INDEX IF NOT EXISTS term_edge_dst ON term_edge (dst_id);

-- ---------------------------------------------------------------- 事件
CREATE TABLE IF NOT EXISTS mem_event (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_id text,
  title      text,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);
CREATE INDEX IF NOT EXISTS mem_event_user_time ON mem_event (user_id, started_at DESC);

-- ---------------------------------------------------------------- L2 事件卡
CREATE TABLE IF NOT EXISTS mem_card (
  id           bigserial PRIMARY KEY,
  event_id     bigint NOT NULL UNIQUE REFERENCES mem_event(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  summary      text NOT NULL,
  intent       text,
  keywords     text[] NOT NULL DEFAULT '{}',
  entities     text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'ready',
  source       text NOT NULL DEFAULT 'user' CHECK (source IN ('user','external','system')),
  category     text NOT NULL DEFAULT 'general' CHECK (category IN ('general','person')),
  importance   real NOT NULL DEFAULT 0.5,
  confidence   real NOT NULL DEFAULT 0.8,
  use_count    int  NOT NULL DEFAULT 0,
  heat         real NOT NULL DEFAULT 0,
  heat_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  last_hit_at  timestamptz,
  stale_at     timestamptz,
  is_skeleton  boolean NOT NULL DEFAULT false,
  skeleton_at  timestamptz,
  pinned       boolean NOT NULL DEFAULT false,
  version      int  NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  -- FR-03：摘要长度受约束，强制"只留结论，不记细节"
  CONSTRAINT mem_card_summary_len CHECK (char_length(summary) BETWEEN 40 AND 600)
);
CREATE INDEX IF NOT EXISTS mem_card_kw   ON mem_card USING gin (keywords);
CREATE INDEX IF NOT EXISTS mem_card_ent  ON mem_card USING gin (entities);
CREATE INDEX IF NOT EXISTS mem_card_time ON mem_card (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mem_card_heat ON mem_card (user_id, heat DESC) WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE mem_card ADD COLUMN IF NOT EXISTS embedding vector(1024)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS mem_card_emb ON mem_card USING hnsw (embedding vector_cosine_ops)';
  END IF;
END $$;

-- 倒排：卡 ↔ 词（多对多）
CREATE TABLE IF NOT EXISTS card_term (
  card_id bigint NOT NULL REFERENCES mem_card(id) ON DELETE CASCADE,
  term_id bigint NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  role    text NOT NULL DEFAULT 'keyword' CHECK (role IN ('subject','intent','keyword','entity')),
  weight  real NOT NULL DEFAULT 1.0,
  PRIMARY KEY (card_id, term_id, role)
);
CREATE INDEX IF NOT EXISTS card_term_term ON card_term (term_id, weight DESC);

-- ---------------------------------------------------------------- L3 明细（按月分区，只追加）
CREATE TABLE IF NOT EXISTS mem_raw (
  id          bigserial,
  event_id    bigint NOT NULL,
  user_id     bigint NOT NULL,
  seq         int  NOT NULL,
  role        text NOT NULL,
  content     text NOT NULL,
  tool_name   text,
  ts          timestamptz NOT NULL DEFAULT now(),
  hash        bytea,
  archived_at timestamptz,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX IF NOT EXISTS mem_raw_event_seq ON mem_raw (event_id, seq);
CREATE INDEX IF NOT EXISTS mem_raw_user_ts ON mem_raw (user_id, ts DESC);

-- 卡 ↔ 原文（多对多，L2→L3 落点；无外键，分区表主键含 ts 的代价，由应用层保证）
CREATE TABLE IF NOT EXISTS card_raw (
  card_id bigint NOT NULL REFERENCES mem_card(id) ON DELETE CASCADE,
  raw_id  bigint NOT NULL,
  weight  real NOT NULL DEFAULT 1.0,
  PRIMARY KEY (card_id, raw_id)
);
CREATE INDEX IF NOT EXISTS card_raw_raw ON card_raw (raw_id);

-- ---------------------------------------------------------------- 晋升候选
CREATE TABLE IF NOT EXISTS promotion_candidate (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('skill','rule','alias','merge')),
  payload     jsonb NOT NULL,
  evidence    bigint[] NOT NULL DEFAULT '{}',
  score       real NOT NULL DEFAULT 0,
  dedupe_key  text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_candidate_dedupe
  ON promotion_candidate (user_id, kind, dedupe_key) WHERE status = 'pending';

-- ---------------------------------------------------------------- 审计与版本
CREATE TABLE IF NOT EXISTS mem_audit (
  id          bigserial PRIMARY KEY,
  user_id     bigint,
  object_type text NOT NULL,
  object_id   bigint NOT NULL,
  op          text NOT NULL,
  before      jsonb,
  after       jsonb,
  actor       text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mem_audit_obj ON mem_audit (object_type, object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mem_audit_time ON mem_audit (created_at DESC);

CREATE TABLE IF NOT EXISTS mem_version (
  id          bigserial PRIMARY KEY,
  object_type text NOT NULL,
  object_id   bigint NOT NULL,
  version     int  NOT NULL,
  snapshot    jsonb NOT NULL,
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_type, object_id, version)
);

-- ---------------------------------------------------------------- 回收站（物理清除前先落此表，7 天内可恢复）
CREATE TABLE IF NOT EXISTS mem_trash (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL,
  object_type text NOT NULL,
  object_id   bigint NOT NULL,
  snapshot    jsonb NOT NULL,
  deleted_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  purge_at    timestamptz NOT NULL,
  restored_at timestamptz
);
CREATE INDEX IF NOT EXISTS mem_trash_purge ON mem_trash (purge_at) WHERE restored_at IS NULL;

-- ---------------------------------------------------------------- 浓缩任务（失败不阻塞对话，指数退避重试）
CREATE TABLE IF NOT EXISTS condense_job (
  id          bigserial PRIMARY KEY,
  event_id    bigint NOT NULL UNIQUE,
  attempts    int NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS condense_job_due ON condense_job (next_at) WHERE status = 'pending';

-- ---------------------------------------------------------------- 迁移记录
CREATE TABLE IF NOT EXISTS schema_migration (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- 初始分区
DO $$
DECLARE
  m date;
  i int;
BEGIN
  FOR i IN -1..2 LOOP
    m := (date_trunc('month', now())::date + (i || ' month')::interval)::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS mem_raw_%s PARTITION OF mem_raw FOR VALUES FROM (%L) TO (%L)',
      to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date
    );
  END LOOP;
END $$;
