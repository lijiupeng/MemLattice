-- 003：注入快照（memory.inspect 的数据源）
-- recall 每轮把"实际注入 / 被丢弃"的明细落库，事后可核对；
-- 不再需要重跑 recall 看 debug——重跑会 touchCardHeat/touchTermHeat，污染要观察的热度信号。

CREATE TABLE IF NOT EXISTS mem_injection (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  query         text NOT NULL,
  scope         text NOT NULL DEFAULT 'all',
  budget_limit  int  NOT NULL,
  budget_used   int  NOT NULL,
  truncated     boolean NOT NULL DEFAULT false,
  blocks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  cards         jsonb NOT NULL DEFAULT '[]'::jsonb,
  hints         jsonb NOT NULL DEFAULT '[]'::jsonb,
  dropped       jsonb NOT NULL DEFAULT '[]'::jsonb,
  dropped_count int NOT NULL DEFAULT 0,
  elapsed_ms    int,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 只按"某人最近 N 条"取值与清理，因此 (user_id, id DESC) 一个索引足够
CREATE INDEX IF NOT EXISTS mem_injection_recent ON mem_injection (user_id, id DESC);
