-- 恢复 recent 为合法 label；已删除的锚点数据无法由 down 恢复
ALTER TABLE mem_block DROP CONSTRAINT IF EXISTS mem_block_label_check;
ALTER TABLE mem_block ADD CONSTRAINT mem_block_label_check CHECK (label IN ('persona','rules','skills','recent'));
