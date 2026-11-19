-- 下线 L1「当前锚点」（recent）块：常驻层收敛为 persona / rules / skills。
-- 锚点定位是临时任务上下文，不承担正式记忆（正式记忆在 L2/L3），随功能一并清除。
DELETE FROM mem_block WHERE label = 'recent';
DELETE FROM promotion_candidate WHERE kind = 'block' AND payload->>'label' = 'recent';

ALTER TABLE mem_block DROP CONSTRAINT IF EXISTS mem_block_label_check;
ALTER TABLE mem_block ADD CONSTRAINT mem_block_label_check CHECK (label IN ('persona','rules','skills'));
