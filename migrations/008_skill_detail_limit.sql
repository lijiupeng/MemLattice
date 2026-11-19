-- 技能详细描述上限扩展：400 → 4000，与 SKILL_DETAIL_MAX_CHARS 默认值一致。
-- 只调 skills 块；DB 的 char_length(content) <= char_limit 检查保持不变。
UPDATE mem_block SET char_limit = 4000
WHERE label = 'skills' AND deleted_at IS NULL AND char_limit <> 4000
  AND char_length(content) <= 4000;
