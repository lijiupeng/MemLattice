-- 005：通用经验（skills/default）也纳入"一句话总结 + 详细描述"模型
-- 004 只回填了 skill:<term_id>；default 槽同样只注入索引，需要补 summary

UPDATE mem_block
SET summary = left(regexp_replace(content, '\s+', ' ', 'g'), 60)
WHERE label = 'skills'
  AND (summary IS NULL OR summary = '')
  AND char_length(btrim(content)) > 0;
