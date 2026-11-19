-- 回滚 004：移除技能摘要与调用次数字段（详细描述保留在 content 里，不丢内容）

UPDATE mem_block SET char_limit = 60
WHERE label = 'skills' AND slot LIKE 'skill:%';

ALTER TABLE mem_block DROP CONSTRAINT IF EXISTS mem_block_summary_len;
ALTER TABLE mem_block DROP COLUMN IF EXISTS summary;
ALTER TABLE mem_block DROP COLUMN IF EXISTS use_count;
