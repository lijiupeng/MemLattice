/* eslint-disable no-console */
/**
 * 安装时播种：把 SKILL.md 的使用说明写进 L1 的第一条技能，并在 rules 里留一句引用。
 *
 * 为什么单独做入口、而不是塞进 bootstrap：
 * bootstrap 每次启动都跑，往上写内容等于每次开机都改用户的库；
 * 安装是一次性动作，适合做播种。删库重建不会自动恢复——这是刻意的。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createTokenizer } from './core/tokenizer.js';
import { bootstrap } from './db/bootstrap.js';
import { closeSql, createSql } from './db/client.js';
import { migrateUp } from './db/migrate.js';
import { correct } from './services/memory.service.js';

/** 只摘这几节：动作型内容。工具语义、接入方式那些留在 SKILL.md 里按需读 */
const SECTIONS = [
  '什么时候用',
  '写入约定',
  '纠正与反馈',
  '睡前整理',
  '人设与规则怎么改',
  '隐私',
];

const SKILL_SUMMARY = 'MemLattice 使用说明：什么时候用、写入、纠错、睡前整理、改人设规则、隐私';

/** 独立槽位：不占用 skills/default，那个槽留给用户自己的通用经验 */
const README_SLOT = 'readme';

const RULE_LINE =
  '【记忆技能】动手做记忆操作前，先取经验索引里那条「MemLattice 使用说明」的正文：' +
  '什么时候用、写入约定、纠正与反馈、睡前整理、人设与规则怎么改、隐私都在那里。' +
  '凭印象做容易踩坑——摘要长度、关键词清洗、pending_approval 的判断都容易错。';

/** 按标题切出选中的几节，标题层级不固定（有的是 ## 有的是 ###） */
function extractSections(markdown: string): { text: string; found: string[] } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const picked: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      const title = heading[1]?.trim() ?? '';
      const hit = SECTIONS.find((name) => title.startsWith(name));
      if (hit) {
        current = { title: hit, body: [] };
        picked.push(current);
        continue;
      }
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }

  const parts = picked.map((section) => `【${section.title}】\n${section.body.join('\n').trim()}`);
  return {
    text: ['【MemLattice 使用说明】', ...parts].join('\n\n'),
    found: picked.map((section) => section.title),
  };
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // 打包结构：runtime/dist/seed-cli.js 与 runtime/dsh/memlattice/SKILL.md 同级
  const skillMd = join(here, '..', 'dsh', 'memlattice', 'SKILL.md');
  if (!existsSync(skillMd)) {
    console.log('没有 SKILL.md，跳过播种');
    return;
  }

  const { text, found } = extractSections(readFileSync(skillMd, 'utf8'));
  if (found.length === 0) {
    console.log('SKILL.md 里没找到目标章节，跳过播种');
    return;
  }

  const cfg = loadConfig();
  const sql = createSql(cfg);
  try {
    await migrateUp(sql, cfg.migrationsDir, () => {});
    const userId = await bootstrap(sql, cfg);
    const tokenizer = await createTokenizer();
    const ctx = { sql, cfg, tokenizer, now: () => new Date(), cachedUserId: userId };

    // 独立槽位，不占 default：default 是「通用经验」，用户往往已经放了别的手册
    // （QQ 操作、项目约定…），塞进去要么被跳过，要么把人家内容挤掉。
    // skills 下每个槽都会进经验索引，所以另起一条即可。
    if ([...text].length > 4000) {
      console.log(`说明书写不进单条（${[...text].length} 字 > 4000），跳过`);
      return;
    }

    const exist = (
      await sql<Array<{ content: string }>>`
        SELECT content FROM mem_block
        WHERE user_id = ${userId} AND label = 'skills' AND slot = ${README_SLOT} AND deleted_at IS NULL`
    )[0];
    // 只跳过块写入，后面的 rules 引用仍要检查——否则第二次安装永远补不上那句引用
    const unchanged = String(exist?.content ?? '').trim() === text.trim();
    if (unchanged) {
      console.log('使用说明书已是最新');
    } else {
      await sql`
        INSERT INTO mem_block (user_id, label, slot, content, summary, char_limit, read_only, source)
        VALUES (${userId}, 'skills', ${README_SLOT}, ${text}, ${SKILL_SUMMARY}, 4000, 0, 'human')
        ON CONFLICT (user_id, label, slot) WHERE deleted_at IS NULL
        DO UPDATE SET content = EXCLUDED.content, summary = EXCLUDED.summary`;
    }

    const ruleRow = (
      await sql<Array<{ content: string }>>`
        SELECT content FROM mem_block
        WHERE user_id = ${userId} AND label = 'rules' AND slot = 'default' AND deleted_at IS NULL`
    )[0];
    const ruleText = String(ruleRow?.content ?? '').trim();
    if (!ruleText.includes('【记忆技能】')) {
      const nextRule = [ruleText, RULE_LINE].filter(Boolean).join('\n\n');
      if ([...nextRule].length <= 2000) {
        await correct(ctx, {
          userId,
          target: { type: 'block', label: 'rules' },
          patch: { content: nextRule },
          reason: '安装时播种：在规则里引用使用说明书',
          actor: 'human',
        });
      }
    }

    console.log(
      unchanged
        ? `使用说明书已就绪（skills/${README_SLOT}）`
        : `已写入使用说明书（skills/${README_SLOT}，${found.length} 节 / ${[...text].length} 字）`,
    );
  } finally {
    await closeSql(sql);
  }
}

main().catch((err: unknown) => {
  console.error('播种失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
