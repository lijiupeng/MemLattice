-- 整理清单里判断过、决定不处理的项：不记下来，下次睡觉还要重新看同一批。
-- object_type 目前覆盖 raw（原文）、term（高频主题）、card（低置信/接近淡忘）。
CREATE TABLE IF NOT EXISTS mem_triage (
  user_id     bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  object_type text   NOT NULL CHECK (object_type IN ('raw', 'term', 'card')),
  object_id   bigint NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, object_type, object_id)
);
