-- 004：固化技能补齐三个字段 —— id / 一句话描述 / 详细描述，并记录调用次数
-- 1) mem_block.summary：一句话说明"这个技能是干什么的"，只有它进 L1 索引
-- 2) mem_block.use_count：被 memory.expand 按 id 取用的次数（看到索引不算调用）
-- 3) skills 的 skill:<term_id> 槽位：content 改为详细描述，字符上限 60 → 400
-- 4) 存量技能把原内容搬进 summary，正文保持可读（调用方可后续补详细描述）

ALTER TABLE mem_block ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE mem_block ADD COLUMN IF NOT EXISTS use_count int NOT NULL DEFAULT 0;

ALTER TABLE mem_block DROP CONSTRAINT IF EXISTS mem_block_summary_len;
ALTER TABLE mem_block
  ADD CONSTRAINT mem_block_summary_len
  CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 200);

UPDATE mem_block
SET summary = content
WHERE label = 'skills'
  AND slot LIKE 'skill:%'
  AND (summary IS NULL OR summary = '')
  AND content <> '';

UPDATE mem_block
SET char_limit = 400
WHERE label = 'skills'
  AND slot LIKE 'skill:%'
  AND char_limit < 400;
