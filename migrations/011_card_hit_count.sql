-- 曝光次数与采用次数（use_count）分开统计：召回命中只算曝光，不给热度。
-- 两者之比用于识别"总被拉出来、从没人用"的噪声卡。
ALTER TABLE mem_card ADD COLUMN hit_count int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS mem_card_precision ON mem_card (user_id, hit_count DESC)
  WHERE deleted_at IS NULL AND hit_count >= 5;
