-- 回滚 002：移除 agent 来源与 block 候选类型
-- 注意：会删除 source='agent' 的块；需要保留时先备份。

DELETE FROM mem_block WHERE source = 'agent';
UPDATE promotion_candidate SET kind = 'rule' WHERE kind = 'block';

ALTER TABLE mem_block DROP CONSTRAINT IF EXISTS mem_block_source_check;
ALTER TABLE mem_block
  ADD CONSTRAINT mem_block_source_check CHECK (source IN ('human', 'promoted'));

ALTER TABLE promotion_candidate DROP CONSTRAINT IF EXISTS promotion_candidate_kind_check;
ALTER TABLE promotion_candidate
  ADD CONSTRAINT promotion_candidate_kind_check CHECK (kind IN ('skill', 'rule', 'alias', 'merge'));
