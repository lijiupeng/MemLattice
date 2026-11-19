-- 不回退：技能正文可能已超过旧上限，降回会违反 CHECK (char_length(content) <= char_limit)。
SELECT 1;
