-- 技能详细描述上限校准到 4000：008 曾把上限定为 1600，本条把存量库统一抬到当前默认值。
-- 幂等：只处理不足 4000 的 skills 块，且正文不超 4000（避免缩短后违反 CHECK）。
UPDATE mem_block SET char_limit = 4000
WHERE label = 'skills' AND deleted_at IS NULL AND char_limit < 4000
  AND char_length(content) <= 4000;
