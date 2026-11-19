-- 运行时可配参数：页面写入这里，覆盖环境变量默认值；进程启动与保存时同步进内存
CREATE TABLE IF NOT EXISTS app_setting (
  user_id    bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      text NOT NULL,
  updated_by text NOT NULL DEFAULT 'human',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
