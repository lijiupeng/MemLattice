/* eslint-disable no-console */
/**
 * 停用 SurfCore 自己的记忆与角色
 *
 * 为什么不是一个开关：
 *   - 记忆有开关（memoryCard.enabled），改配置即可，但 QQ 侧还会读现成的注入文件，
 *     所以文件也要清掉，否则关开关前生成的那份还会被拼进 prompt
 *   - 人格没有总开关（persona 只有 full/split 两种注入方式），只能改文件内容
 *
 * 三个动作：
 *   disable  备份后清空人格与记忆注入文件，并关掉记忆卡开关
 *   restore  从备份原样还原
 *   status   看当前是停用还是原样
 *
 * 用法：
 *   npx tsx scripts/surfcore-detach.mts disable [--char <dir>]
 *   npx tsx scripts/surfcore-detach.mts restore [--char <dir>]
 *   npx tsx scripts/surfcore-detach.mts status  [--char <dir>]
 *
 * 想用 MemLattice 的人格替换而不是清空，用 surfcore-bridge 的 sync --persona。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKUP_DIR = '.detach-backup';
/** roles/ 下角色卡停用后的后缀：不是 .md 就不会被 listPersonaCards 选中 */
const ROLES_SUFFIX = '.off';

function repoRoot(): string {
  const explicit = argv('repo') ?? process.env.SURFCORE_HOME;
  if (explicit) return resolve(explicit);
  return join(homedir(), 'surfcore');
}

/** 会被清空的人格与记忆文件，都是相对角色目录的路径 */
const TOUCHED = [
  'persona.md',
  'persona.full.md',
  'persona.tone.md',
  'persona.daily.md',
  'memory/memory-card.md',
  'memory/memory-card-prompt-qq.md',
  'memory/memory-card-prompt-bili.md',
  // 唤醒提示里还会拼【B站记忆】，来源是这两个文件，不清就一直在
  'bili/bili-memory.md',
  'bili/bili-memory-brief.md',
  // 全量卡与待处理队列：前者可能被当记忆段读，后者会持续触发写入
  'memory/memory-card-full.md',
  'memory/memory-inbox.jsonl',
];

function argv(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveCharDir(): string {
  const explicit = argv('char');
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
  throw new Error('找不到当前角色，用 --char <dir> 指定');
}

function unifiedConfigPath(): string {
  return join(homedir(), '.dsh', 'surfcore', 'config.json');
}

/** 备份文件按原始相对路径存放，还原时能一一对上 */
function backupPathFor(charDir: string, rel: string): string {
  const target = join(charDir, BACKUP_DIR, rel);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

function haveBackup(charDir: string): boolean {
  return existsSync(join(charDir, BACKUP_DIR));
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * roles/ 是人格文件的第二来源：清空角色包里的 persona.md 之后，
 * resolvePersonaFile() 会继续往下找，最后落到 roles/ 下的示例角色卡。
 * 改名而不是删，内容留着，方便随时改回来。
 */
function detachRoleFiles(apply: boolean): void {
  const dir = join(repoRoot(), 'roles');
  if (!existsSync(dir)) return;
  let changed = 0;
  for (const name of readdirSync(dir)) {
    if (name.toLowerCase() === 'readme.md') continue;
    if (apply && name.endsWith('.md')) {
      renameSync(join(dir, name), join(dir, `${name}${ROLES_SUFFIX}`));
      changed += 1;
    } else if (!apply && name.endsWith(`.md${ROLES_SUFFIX}`)) {
      renameSync(join(dir, name), join(dir, name.slice(0, -ROLES_SUFFIX.length)));
      changed += 1;
    }
  }
  if (changed > 0) console.log(`roles/：${apply ? '已停用' : '已恢复'} ${changed} 张角色卡`);
}

export function disable(charDir: string): void {
  const backupRoot = join(charDir, BACKUP_DIR);
  mkdirSync(backupRoot, { recursive: true });

  const cleared: string[] = [];
  for (const rel of TOUCHED) {
    const file = join(charDir, rel);
    if (!existsSync(file)) continue;
    // 逐文件备份：已备份过的不覆盖，避免第二次运行时拿空文件顶掉原件
    const bak = join(backupRoot, rel);
    if (!existsSync(bak)) {
      mkdirSync(dirname(bak), { recursive: true });
      copyFileSync(file, bak);
    }
    if (readFileSync(file, 'utf8').length === 0) continue;
    writeFileSync(file, '', 'utf8');
    cleared.push(rel);
  }

  // 配置层：关掉记忆卡，B站与桌宠侧会直接不再注入
  const cfgFile = unifiedConfigPath();
  if (existsSync(cfgFile)) {
    copyFileSync(cfgFile, join(backupRoot, basename(cfgFile)));
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    const card = (cfg.memoryCard ?? {}) as Record<string, unknown>;
    card.enabled = false;
    cfg.memoryCard = card;
    writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  }

  console.log(`角色目录：${charDir}`);
  console.log(`已清空 ${cleared.length} 个文件：${cleared.join('、') || '（本来就没有）'}`);
  console.log(`已关闭 memoryCard.enabled`);
  console.log(`备份在：${backupRoot}`);
  console.log('\n重启 DSH（含 QQ 桥接）后生效。');
  console.log('此时它的 prompt 里既没有人格段，也没有记忆段。');
  detachRoleFiles(true);
}

export function restore(charDir: string): void {
  const backupRoot = join(charDir, BACKUP_DIR);
  if (!existsSync(backupRoot)) {
    console.log('没有找到备份，无法还原');
    return;
  }
  let restored = 0;
  for (const rel of TOUCHED) {
    const bak = join(backupRoot, rel);
    if (!existsSync(bak)) continue;
    const target = join(charDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(bak, target);
    restored += 1;
  }
  const cfgBak = join(backupRoot, 'config.json');
  if (existsSync(cfgBak)) {
    copyFileSync(cfgBak, unifiedConfigPath());
    restored += 1;
  }
  rmSync(backupRoot, { recursive: true, force: true });
  console.log(`已还原 ${restored} 个文件，备份目录已清理`);
  detachRoleFiles(false);
  console.log('重启 DSH 后生效。');
}

function status(charDir: string): void {
  const disabled = haveBackup(charDir);
  console.log(`角色：${charDir}`);
  console.log(`状态：${disabled ? '已停用（人格与记忆文件为空，配置层已关）' : '原样（它自己的人格与记忆仍生效）'}`);
  const rolesDir = join(repoRoot(), 'roles');
  if (existsSync(rolesDir)) {
    const left = readdirSync(rolesDir).filter(
      (name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md',
    );
    console.log(
      `roles/ 可用角色卡：${left.length === 0 ? '0（已全部停用）' : `${left.length}（${left.join('、')}）`}`,
    );
  }
  for (const rel of TOUCHED) {
    const file = join(charDir, rel);
    if (!existsSync(file)) {
      console.log(`  ${rel.padEnd(32)} 不存在`);
      continue;
    }
    const size = readFileSync(file, 'utf8').length;
    console.log(`  ${rel.padEnd(32)} ${size} 字`);
  }
  const cfgFile = unifiedConfigPath();
  if (existsSync(cfgFile)) {
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as { memoryCard?: { enabled?: boolean } };
    console.log(`  memoryCard.enabled            ${cfg.memoryCard?.enabled ?? true}`);
  }
}

// 被别的脚本 import 时不要执行 CLI，只有直接运行时才解析参数
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
})();

if (isMain) {
  const command = process.argv[2] ?? 'status';
  const charDir = resolveCharDir();
  if (command === 'disable') disable(charDir);
  else if (command === 'restore') restore(charDir);
  else if (command === 'status') status(charDir);
  else {
    console.log('用法：disable | restore | status  [--char <dir>]');
    process.exitCode = 1;
  }
}
