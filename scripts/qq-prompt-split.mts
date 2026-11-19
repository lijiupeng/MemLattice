/* eslint-disable no-console */
/**
 * 把 SurfCore 的 QQ 提示词拆开分类
 *
 * 那段提示词是拼出来的：设定、行为规则、工具手册、每轮变化的状态混在一张纸上。
 * 想让它改由 MemLattice 提供，得先按段落拆开——同一段内容该进 rules 还是 skills，
 * 决定了它以后在什么时候被看见。
 *
 * 用法：
 *   npx tsx scripts/qq-prompt-split.mts --file <路径>            只分类，打印结果
 *   npx tsx scripts/qq-prompt-split.mts --file <路径> --json     输出 JSON（给别的脚本用）
 *
 * 分类口径：
 *   persona  我是谁、我和主人的关系        → L1 persona
 *   rules    必须遵守的行为约束            → L1 rules
 *   skills   怎么用某个工具/功能           → L1 skills
 *   memory   我的经历（B站那条线）         → L2 卡片，不进 L1
 *   state    每轮都变（时间、未读、令牌）  → 丢弃，不能落库
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createTokenizer } from '../src/core/tokenizer.js';
import { bootstrap } from '../src/db/bootstrap.js';
import { closeSql, createSql } from '../src/db/client.js';
import { migrateUp } from '../src/db/migrate.js';
import type { Ctx } from '../src/services/context.js';
import { correct, write } from '../src/services/memory.service.js';

type Category = 'persona' | 'rules' | 'skills' | 'memory' | 'state';

interface Section {
  title: string;
  body: string;
  category: Category;
  /** 为什么这么分，写进报告里方便人复核 */
  reason: string;
}

/** 按标题匹配，匹配不到就落到 rules（保守：宁可当约束，也不当设定） */
const CLASSIFY: Array<{ test: RegExp; category: Category; reason: string }> = [
  { test: /当前时间|当前会话|此刻状态|本次消息快照|会话令牌|参与度参考/, category: 'state', reason: '每轮都会变，落库会立刻过期' },
  { test: /当前角色|你的身份|只用于自己/, category: 'persona', reason: '我是谁、称呼怎么来' },
  { test: /B站记忆/, category: 'memory', reason: '我的经历，属于会被检索的内容而不是约束' },
  { test: /表情包|表情匹配|语音状态|引导唤醒|当前唤醒/, category: 'skills', reason: '工具怎么用、当前能力开关' },
  { test: /反AI味|积极性|对话收尾|Token 防爆|沉睡前|首回复节奏|来源判断/, category: 'rules', reason: '行为约束，跨会话不变' },
];

function classify(title: string): { category: Category; reason: string } {
  for (const rule of CLASSIFY) {
    if (rule.test.test(title)) return { category: rule.category, reason: rule.reason };
  }
  return { category: 'rules', reason: '没匹配到专门类别，按约束处理' };
}

/**
 * 段落边界：【标题】 或 ## 标题，正文到下一个标题为止。
 * 用 split 而不是逐行状态机：标题与正文常常在同一行（【反AI味】你不是客服…），
 * 逐行处理时那段正文很容易被并进上一段。
 */
function splitSections(text: string): Section[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const chunks = normalized.split(/\n(?=【[^】\n]+】|##\s)/);
  const out: Section[] = [];
  for (const chunk of chunks) {
    const [firstLine = '', ...rest] = chunk.split('\n');
    const tagged = firstLine.match(/^【([^】]+)】\s*(.*)$/);
    const heading = firstLine.match(/^##\s+(.+)$/);
    const title = (tagged?.[1] ?? heading?.[1] ?? '').trim();
    const inline = (tagged?.[2] ?? '').trim();
    const body = [inline, ...rest].join('\n').trim();
    if (!title && !body) continue;
    out.push({ title, body, ...classify(title) });
  }
  return out;
}

function formatSection(section: Section): string {
  return section.title ? `【${section.title}】\n${section.body}` : section.body;
}

async function applyToLibrary(sections: Section[]): Promise<void> {
  const cfg = loadConfig();
  const sql = createSql(cfg);
  try {
    await migrateUp(sql, cfg.migrationsDir, () => {});
    const userId = await bootstrap(sql, cfg);
    const tokenizer = await createTokenizer();
    const ctx: Ctx = { sql, cfg, tokenizer, now: () => new Date(), cachedUserId: userId };
    const pick = (category: Category): Section[] =>
      sections.filter((section) => section.category === category);

    // 设定并进 rules：设定类接进规则模块；persona 保持原样，不覆盖人设
    const rulesText = [...pick('persona'), ...pick('rules')].map(formatSection).join('\n\n');
    const skillsText = pick('skills').map(formatSection).join('\n\n');
    const memoryText = pick('memory').map(formatSection).join('\n\n');

    if (rulesText) {
      const res = await correct(ctx, {
        userId,
        target: { type: 'block', label: 'rules' },
        patch: { content: rulesText },
        reason: '从 SurfCore 的 QQ 提示词接入：设定与行为约束',
        actor: 'human',
      });
      console.log(`\nrules 已写入 ${[...rulesText].length} 字（v${res.version}）`);
    }
    if (skillsText) {
      const res = await correct(ctx, {
        userId,
        target: { type: 'block', label: 'skills' },
        patch: { content: skillsText },
        reason: '从 SurfCore 的 QQ 提示词接入：工具使用手册',
        actor: 'human',
      });
      console.log(`skills 已写入 ${[...skillsText].length} 字（v${res.version}）`);
    }
    if (memoryText) {
      const summary = `[B站] 我在 B 站的账号身份与使用习惯：${memoryText.replace(/\s+/g, ' ').slice(0, 460)}`;
      const res = await write(ctx, {
        messages: [{ role: 'user', content: memoryText }],
        source: 'external',
        new_event: true,
        close: true,
        card: {
          summary,
          intent: '信息同步',
          keywords: ['B站记忆', '账号身份', '内容偏好'],
          entities: [],
          importance: 0.7,
        },
      });
      console.log(`B站记忆已写成卡 #${res.card_id}`);
    }
  } finally {
    await closeSql(sql);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fileArg = argv.indexOf('--file');
  const asJson = argv.includes('--json');
  const apply = argv.includes('--apply');

  if (fileArg < 0) {
    console.error('用法：npx tsx scripts/qq-prompt-split.mts --file <路径> [--json] [--apply]');
    console.error('  --apply  把分类结果写进 MemLattice（本地库）：设定+规则→rules，技能→skills，B站记忆→L2 卡');
    process.exit(1);
  }
  const file = resolve(argv[fileArg + 1] ?? '');
  if (!existsSync(file)) {
    console.error(`文件不存在：${file}`);
    process.exit(1);
  }

  const sections = splitSections(readFileSync(file, 'utf8'));
  if (asJson) {
    console.log(JSON.stringify({ sections }, null, 2));
    return;
  }

  const order: Category[] = ['persona', 'rules', 'skills', 'memory', 'state'];
  const label: Record<Category, string> = {
    persona: '设定（并入 rules）',
    rules: '规则（进 rules）',
    skills: '技能（进 skills）',
    memory: '经历（进 L2 卡片）',
    state: '状态（丢弃）',
  };

  console.log(`来源：${file}`);
  console.log(`共 ${sections.length} 段\n`);

  let totalKept = 0;
  for (const category of order) {
    const group = sections.filter((section) => section.category === category);
    if (group.length === 0) continue;
    const chars = group.reduce((sum, section) => sum + [...section.body].length, 0);
    if (category !== 'state') totalKept += chars;
    console.log(`\x1b[36m${label[category]}\x1b[0m  ${group.length} 段 / ${chars} 字`);
    for (const section of group) {
      const head = section.title ? `【${section.title}】` : '（开头无标题）';
      console.log(`  · ${head}  ${[...section.body].length} 字  —— ${section.reason}`);
    }
  }

  console.log(`\n需要落库的合计：${totalKept} 字`);
  console.log('（rules 上限 2000、skills 上限 4000；超了要精简或拆条）');

  if (apply) {
    // 以脚本自身位置定位迁移目录：仓库里跑是 <root>/migrations，装进包后是 runtime/migrations
    const here = dirname(fileURLToPath(import.meta.url));
    const runtimeRoot = resolve(here, '..');
    process.env.DB_DIALECT ??= 'sqlite';
    process.env.SQLITE_PATH ??= join(homedir(), '.memlattice', 'data', 'memlattice.db');
    process.env.MIGRATIONS_DIR ??= join(runtimeRoot, 'migrations', 'sqlite');
    await applyToLibrary(sections);
  }
}

main().catch((err: unknown) => {
  console.error('失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
