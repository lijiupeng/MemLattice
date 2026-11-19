/* eslint-disable no-console */
/**
 * SurfCore ↔ MemLattice 桥接
 *
 * SurfCore 把记忆整理成一张 Markdown 卡（memory-card.md）整段拼进 prompt，
 * 真正的结构化数据在 memory/memory-card.json 的 records 里。
 * 这个脚本做三件事，都不改 SurfCore 源码：
 *
 *   import  角色包 → MemLattice（persona 进 L1，records 进 L2 卡）
 *   export  MemLattice → 角色包（还原，写前先整目录备份）
 *   sync    把 L1 + 一次检索结果渲染成 memory-card-prompt-*.md（接管注入层）
 *
 * 用法：
 *   npx tsx scripts/surfcore-bridge.mts import [--char <dir>] [--persona]
 *   npx tsx scripts/surfcore-bridge.mts export [--char <dir>]
 *   npx tsx scripts/surfcore-bridge.mts sync   [--char <dir>] --query "..." [--platform qq|bili]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createTokenizer } from '../src/core/tokenizer.js';
import { bootstrap } from '../src/db/bootstrap.js';
import { closeSql, createSql } from '../src/db/client.js';
import { migrateUp } from '../src/db/migrate.js';
import type { Ctx } from '../src/services/context.js';
import { getCardDetail } from '../src/services/governance.service.js';
import { correct, recall, startPreview, write } from '../src/services/memory.service.js';

const MAP_PATH = join(homedir(), '.memlattice', 'surfcore-map.json');

interface SurfRecord {
  id: string;
  createdAt?: string;
  platform?: string;
  scope?: string;
  kind?: string;
  title?: string;
  text?: string;
  importance?: number;
  clarity?: number;
  pinned?: boolean;
  tags?: string[];
  speaker?: string;
  private?: boolean;
  isInitial?: boolean;
  firstMet?: boolean;
}

interface SurfCard {
  version?: number;
  records?: SurfRecord[];
  meta?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  [key: string]: unknown;
}

interface BridgeMap {
  charId: string;
  charDir: string;
  importedAt: string;
  personaBlockId?: number;
  /** surfcore record.id → MemLattice 卡 */
  records: Record<string, { card_id: number; event_id: number }>;
}

/* ---------------------------------------------------------------- 参数 */

function argv(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function resolveCharDir(explicit?: string): string {
  if (explicit) {
    const dir = resolve(explicit);
    if (!existsSync(dir)) throw new Error(`角色目录不存在：${dir}`);
    return dir;
  }
  const current = join(homedir(), '.dsh', 'surfcore', 'characters', 'current.json');
  if (existsSync(current)) {
    const meta = JSON.parse(readFileSync(current, 'utf8')) as { dir?: string };
    if (meta.dir && existsSync(meta.dir)) return meta.dir;
  }
  throw new Error('找不到当前角色，请用 --char <dir> 指定');
}

/* ---------------------------------------------------------------- 映射 */

function readMap(): BridgeMap | null {
  if (!existsSync(MAP_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as BridgeMap;
  } catch {
    return null;
  }
}

function writeMap(map: BridgeMap): void {
  mkdirSync(join(homedir(), '.memlattice'), { recursive: true });
  writeFileSync(MAP_PATH, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

/* ---------------------------------------------------------------- 工具 */

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * SurfCore 的记录常常只有一句话，MemLattice 的卡要求 40–600 字，
 * 所以拼上来源前缀，太短就补一句说明，太长截断。
 */
function buildSummary(record: SurfRecord): string {
  const head = `[${record.platform ?? 'qq'}/${record.kind ?? 'memory'}] ${(record.title ?? '').trim()}`.trim();
  const body = (record.text ?? '').trim();
  const merged = `${head}：${body}`.replace(/\s+/g, ' ');
  if ([...merged].length >= 40) return [...merged].slice(0, 560).join('');
  const pad = '（来自 SurfCore 导入，原始记录较短，细节见关联原文。）';
  return `${merged}${pad}`.slice(0, 600);
}

function keywordsOf(record: SurfRecord): string[] {
  const tags = (record.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
  const title = (record.title ?? '').trim();
  if (title && tags.length < 3) tags.unshift(title);
  return [...new Set(tags)].slice(0, 3);
}

/* ---------------------------------------------------------------- import */

async function cmdImport(ctx: Ctx, userId: number, charDir: string): Promise<void> {
  const character = readJson<{ id?: string; name?: string }>(join(charDir, 'character.json'), {});
  const cardFile = join(charDir, 'memory', 'memory-card.json');
  const card = readJson<SurfCard>(cardFile, { records: [] });
  const records = card.records ?? [];

  const map: BridgeMap = readMap() ?? {
    charId: character.id ?? 'unknown',
    charDir,
    importedAt: new Date().toISOString(),
    records: {},
  };
  map.charDir = charDir;
  map.charId = character.id ?? map.charId;

  console.log(`角色：${character.name ?? '(未命名)'}  ${charDir}`);
  console.log(`记录：${records.length} 条，已导入 ${Object.keys(map.records).length} 条`);

  // 1) persona → L1（默认不覆盖，避免冲掉现有阿澜人设）
  const personaFile = join(charDir, 'persona.md');
  if (existsSync(personaFile)) {
    const persona = readFileSync(personaFile, 'utf8').trim();
    const existing = await ctx.sql<Array<{ id: number; content: string }>>`
      SELECT id, content FROM mem_block
      WHERE user_id = ${userId} AND label = 'persona' AND deleted_at IS NULL`;
    const current = (existing[0]?.content ?? '').trim();
    if (!persona) {
      console.log('persona：文件为空，跳过');
    } else if (current && !hasFlag('persona')) {
      console.log(`persona：现有块非空（${[...current].length} 字），跳过。加 --persona 覆盖`);
    } else {
      // persona 块上限 2000 字，SurfCore 的人格卡常比这长；截断并留出原文位置
      const LIMIT = 1900;
      const chars = [...persona];
      const content =
        chars.length > LIMIT
          ? `${chars.slice(0, LIMIT - 60).join('')}\n\n（已截断，完整人格卡见 ${personaFile}）`
          : persona;
      const res = await correct(ctx, {
        userId,
        target: { type: 'block', label: 'persona' },
        patch: { content },
        reason: `SurfCore 角色接管：${character.name ?? character.id ?? charDir}`,
        actor: 'human',
      });
      map.personaBlockId = res.object_id;
      console.log(
        `persona：已写入 v${res.version}（${chars.length} 字${
          chars.length > LIMIT ? `，截到 ${LIMIT}` : ''
        }）`,
      );
    }
  }

  // 2) records → L2 卡（逐条独立事件，source=external 表示内容来自外部导入）
  let imported = 0;
  let skipped = 0;
  for (const record of records) {
    if (!record?.id) continue;
    if (map.records[record.id]) {
      skipped += 1;
      continue;
    }
    const text = (record.text ?? record.title ?? '').trim();
    if (!text) {
      skipped += 1;
      continue;
    }
    const res = await write(ctx, {
      messages: [{ role: 'user', content: text.slice(0, 8000) }],
      source: 'external',
      new_event: true,
      close: true,
      card: {
        summary: buildSummary(record),
        intent: '信息同步',
        keywords: keywordsOf(record),
        entities: [],
        importance: clamp(Number(record.importance ?? 0.5), 0, 1),
      },
    });
    map.records[record.id] = { card_id: res.card_id, event_id: res.event_id };
    imported += 1;
  }

  map.importedAt = new Date().toISOString();
  writeMap(map);
  console.log(`完成：新增 ${imported} 条，跳过 ${skipped} 条，映射写入 ${MAP_PATH}`);
}

/* ---------------------------------------------------------------- export */

function renderCardMarkdown(records: SurfRecord[]): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const lines = [
    '# 记忆卡',
    '',
    `> 更新：${stamp}（由 MemLattice 回写）`,
    '> 规则：最初（和主人初次接触的 30 天）/ 最近 / 重要的事保持清晰；其余会随时间模糊；记不清的就不要编。',
    '',
  ];
  if (records.length === 0) {
    lines.push('（还没有记忆：B站 冲浪、QQ 聊天和桌宠对话会慢慢写进来。）');
    return `${lines.join('\n')}\n`;
  }
  for (const record of records) {
    const tag = `[${record.platform ?? 'qq'}/${record.kind ?? 'memory'}]`;
    const title = record.title ? `${record.title}：` : '';
    lines.push(`- ${tag} ${title}${(record.text ?? '').replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function cmdExport(ctx: Ctx, userId: number, charDir: string): Promise<void> {
  const map = readMap();
  if (!map) throw new Error(`没有导入映射（${MAP_PATH}），先跑 import`);

  const memoryDir = join(charDir, 'memory');
  const cardFile = join(memoryDir, 'memory-card.json');
  const card = readJson<SurfCard>(cardFile, { records: [] });
  const records = card.records ?? [];

  // 备份整目录：还原过程要能整体退回
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(memoryDir, `backup-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(cardFile)) cpSync(cardFile, join(backupDir, 'memory-card.json'));
  const mdFile = join(memoryDir, 'memory-card.md');
  if (existsSync(mdFile)) cpSync(mdFile, join(backupDir, 'memory-card.md'));
  console.log(`备份：${backupDir}`);

  // 用 MemLattice 的最新摘要覆盖对应记录，其余字段原样保留
  let updated = 0;
  for (const record of records) {
    const link = map.records[record.id];
    if (!link) continue;
    try {
      const detail = await getCardDetail(ctx, userId, link.card_id);
      const summary = String((detail.card as { summary?: string }).summary ?? '').trim();
      if (summary) {
        record.text = summary;
        updated += 1;
      }
    } catch {
      console.warn(`卡 ${link.card_id} 读取失败，保留原值`);
    }
  }

  writeFileSync(cardFile, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
  writeFileSync(mdFile, renderCardMarkdown(records), 'utf8');
  console.log(`完成：更新 ${updated} 条记录`);
}

/* ---------------------------------------------------------------- sync */

async function cmdSync(ctx: Ctx, userId: number, charDir: string): Promise<void> {
  const query = argv('query');
  if (!query) throw new Error('sync 需要 --query "...", 用当前这轮的话作为检索词');
  const platform = argv('platform') === 'bili' ? 'bili' : 'qq';
  const map = readMap();
  const character = readJson<{ name?: string }>(join(charDir, 'character.json'), {});

  const start = await startPreview(ctx, userId);
  const result = await recall(ctx, { query, budget_tokens: 1200, include_weak: true });

  const lines: string[] = [
    '# 记忆卡（MemLattice）',
    '',
    `> 生成：${new Date().toISOString()} · 角色 ${character.name ?? '未知'} · 平台 ${platform}`,
    `> 检索词：${query}`,
    '',
  ];
  for (const block of start.blocks) {
    const title = block.label === 'persona' ? '人设' : block.label === 'rules' ? '规则' : '经验索引';
    lines.push(`## ${title}`, '', block.text.trim(), '');
  }
  if (result.cards.length > 0) {
    lines.push('## 相关记忆', '');
    for (const card of result.cards) {
      lines.push(`- #${card.id} ${card.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    lines.push('');
  } else {
    lines.push('## 相关记忆', '', '（这轮没有强关联记忆）', '');
  }
  if (result.hints.length > 0) {
    lines.push('## 可能相关（只提一句）', '');
    for (const hint of result.hints) lines.push(`- ${hint.text}`);
    lines.push('');
  }

  const file = join(charDir, 'memory', `memory-card-prompt-${platform}.md`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`已写入 ${file}（${[...lines.join('\n')].length} 字）`);
  if (map) console.log(`角色 ${map.charId}`);
}

/* ---------------------------------------------------------------- main */

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['import', 'export', 'sync'].includes(command)) {
    console.log('用法：');
    console.log('  npx tsx scripts/surfcore-bridge.mts import [--char <dir>] [--persona]');
    console.log('  npx tsx scripts/surfcore-bridge.mts export [--char <dir>]');
    console.log('  npx tsx scripts/surfcore-bridge.mts sync   [--char <dir>] --query "..." [--platform qq|bili]');
    process.exitCode = 1;
    return;
  }

  const charDir = resolveCharDir(argv('char'));
  const cfg = loadConfig();
  const sql = createSql(cfg);
  try {
    await migrateUp(sql, cfg.migrationsDir, () => {});
    const userId = await bootstrap(sql, cfg);
    const tokenizer = await createTokenizer();
    const ctx: Ctx = { sql, cfg, tokenizer, now: () => new Date(), cachedUserId: userId };

    if (command === 'import') await cmdImport(ctx, userId, charDir);
    else if (command === 'export') await cmdExport(ctx, userId, charDir);
    else await cmdSync(ctx, userId, charDir);
  } finally {
    await closeSql(sql);
  }
}

main().catch((err: unknown) => {
  console.error('失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
