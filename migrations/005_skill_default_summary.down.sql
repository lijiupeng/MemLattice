-- 回滚 005：通用经验容器的 summary 会被清空（正文不受影响）

UPDATE mem_block SET summary = NULL
WHERE label = 'skills' AND slot = 'default';
