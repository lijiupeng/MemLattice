-- 不回退：技能正文可能已超过旧上限 400，降回会违反 CHECK (char_length(content) <= char_limit)。
-- 如需还原旧额度，先手工缩短所有 skills 块正文再单独执行 UPDATE。
SELECT 1;
