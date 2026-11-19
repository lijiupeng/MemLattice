-- 002：允许 MCP 调用方写入 L1 常驻块，并支持"人工审核"候选
-- 1) mem_block.source 增加 agent（模型直写或审核通过后落库）
-- 2) promotion_candidate.kind 增加 block（待审的常驻块变更）

ALTER TABLE mem_block DROP CONSTRAINT IF EXISTS mem_block_source_check;
ALTER TABLE mem_block
  ADD CONSTRAINT mem_block_source_check CHECK (source IN ('human', 'promoted', 'agent'));

ALTER TABLE promotion_candidate DROP CONSTRAINT IF EXISTS promotion_candidate_kind_check;
ALTER TABLE promotion_candidate
  ADD CONSTRAINT promotion_candidate_kind_check CHECK (kind IN ('skill', 'rule', 'alias', 'merge', 'block'));
