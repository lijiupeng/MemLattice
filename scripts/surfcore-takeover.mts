/* eslint-disable no-console */
/**
 * 让 SurfCore 的记忆改由 MemLattice 提供
 *
 * 它原本在会话开始时把人设和记忆卡整段拼进 prompt；MemLattice 是让 AI 按需调工具取。
 * 所以接管要做两件事，缺一不可：
 *   1. 停掉它的注入（人格与记忆文件清空），AI 不再"一上来就知道"
 *   2. 把 MemLattice 的 MCP 挂进 DSH，并在 QQ 的白名单里放行，让 AI 能自己去取
 *
 * 远程不需要桥：DSH 内置 mcp-client 支持 Streamable HTTP，而且 MemLattice 的
 * /mcp 端点认 ?token= 查询参数，所以一个 url 就够，不依赖任何本地进程。
 *
 * 用法：
 *   npx tsx scripts/surfcore-takeover.mts apply  [--repo <dir>] [--profile desktop] [--token <t>] [--url <u>]
 *   npx tsx scripts/surfcore-takeover.mts revert [--repo <dir>] [--profile desktop]
 *   npx tsx scripts/surfcore-takeover.mts status [--repo <dir>] [--profile desktop]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disable, restore } from './surfcore-detach.mjs';

/** 本仓库根（MemLattice）：脚本在 scripts/ 下，往上一层 */
const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BAK_SUFFIX = '.bak-memlattice';
const TOOL_PREFIX = 'mcp__memlattice__';
const MCP_ID = 'mcp-memlattice';
const MCP_END_MARK = '# === qq-bridge MCP END ===';

function argv(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function repoRoot(): string {
  const fromArg = argv('repo');
  if (fromArg) return resolve(fromArg);
  const guess = join(homedir(), 'surfcore');
  if (!existsSync(guess)) throw new Error('找不到 surfcore 仓库，用 --repo <dir> 指定');
  return guess;
}

function profilePatch(): string {
  const name = argv('profile') ?? 'desktop';
  const file = join(homedir(), '.dsh', 'profiles', name, 'cordis.patch.yml');
  if (!existsSync(file)) throw new Error(`找不到 profile 配置：${file}`);
  return file;
}

function charDir(): string {
  const explicit = argv('char');
  if (explicit) return resolve(explicit);
  const current = join(homedir(), '.dsh', 'surfcore', 'characters', 'current.json');
  if (existsSync(current)) {
    const meta = JSON.parse(readFileSync(current, 'utf8')) as { dir?: string };
    if (meta.dir && existsSync(meta.dir)) return meta.dir;
  }
  throw new Error('找不到当前角色，用 --char <dir> 指定');
}

function backupOnce(file: string): string {
  const bak = `${file}${BAK_SUFFIX}`;
  if (!existsSync(bak)) copyFileSync(file, bak);
  return bak;
}

/* ------------------------------------------------------- 3. 记忆写入 */

const TIMER_ENV = 'SURFCORE_DISABLE_MEMORY_TIMER';

/**
 * runMemoryCardMaintenance 自己不检查 enabled，只由定时器每 10 分钟调一次，
 * 所以必须让定时器不启动；用户级环境变量在 DSH 重启后对插件进程生效。
 */
function setTimerEnv(value: string | null): void {
  try {
    execFileSync('setx', [TIMER_ENV, value ?? ''], { stdio: 'ignore' });
  } catch {
    console.warn(`设置环境变量失败，请手动执行：setx ${TIMER_ENV} ${value ?? '""'}`);
  }
}

function timerEnvValue(): string {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${TIMER_ENV}','User')`],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------- 1. 工具白名单 */

function patchWhitelist(repo: string, apply: boolean): void {
  const file = join(repo, 'plugins', 'surfcore', 'qq-tool-restrict.mjs');
  if (!existsSync(file)) throw new Error(`找不到白名单文件：${file}`);
  const text = readFileSync(file, 'utf8');

  if (!apply) {
    const bak = `${file}${BAK_SUFFIX}`;
    if (!existsSync(bak)) {
      console.log('白名单：没有备份，跳过');
      return;
    }
    copyFileSync(bak, file);
    console.log('白名单：已还原');
    return;
  }

  if (text.includes(`'${TOOL_PREFIX}'`)) {
    console.log('白名单：已包含 memlattice，跳过');
    return;
  }
  const anchor = 'const SAFE_PREFIXES = [\n';
  if (!text.includes(anchor)) throw new Error('白名单结构变了：找不到 SAFE_PREFIXES 数组');
  backupOnce(file);
  writeFileSync(file, text.replace(anchor, `${anchor}  '${TOOL_PREFIX}',\n`), 'utf8');
  console.log(`白名单：已加入 ${TOOL_PREFIX}`);
}

/* ------------------------------------------------------- 2. MCP 挂载 */

/**
 * 和组合包同一形态：stdio + 本地 SQLite。
 * 指向仓库里的 dist，不依赖 npm 上的版本，开发期改完代码重建即可生效。
 * 正式分发给别人时这条由组合包自带（npx -y dsh-memlattice@<版本> serve），不用手写。
 */
function mcpBlock(repo: string): string {
  const quote = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  const entry = join(repo, 'dist', 'mcp-stdio.js');
  if (!existsSync(entry)) throw new Error(`缺少 ${entry}，先执行 npm run build`);
  const dbPath = join(homedir(), '.memlattice', 'data', 'memlattice.db');
  return [
    '- insert:',
    `    - id: ${MCP_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: memlattice',
    '        transport: stdio',
    `        command: ${quote(process.execPath)}`,
    '        args:',
    `          - ${quote(entry)}`,
    '        env:',
    "          DB_DIALECT: 'sqlite'",
    `          SQLITE_PATH: ${quote(dbPath)}`,
    `          MIGRATIONS_DIR: ${quote(join(repo, 'migrations', 'sqlite'))}`,
    // DSH 没有 CodeBuddy 的会话钩子，下发自检只会让它去找不存在的文件
    "          HOOK_CHECK: 'off'",
    '',
  ].join('\n');
}

function patchMcp(apply: boolean, repo: string): void {
  const file = profilePatch();
  const text = readFileSync(file, 'utf8');

  if (!apply) {
    const bak = `${file}${BAK_SUFFIX}`;
    if (!existsSync(bak)) {
      console.log('MCP：没有备份，跳过');
      return;
    }
    copyFileSync(bak, file);
    console.log('MCP：cordis.patch.yml 已还原');
    return;
  }

  if (text.includes(`id: ${MCP_ID}`)) {
    // 已存在时整段替换，否则改了 env 也传不进去（版本升级、补开关都会踩这个）
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.includes(`id: ${MCP_ID}`));
    let start = at;
    while (start > 0 && !(lines[start] ?? '').startsWith('- insert:')) start -= 1;
    let end = at;
    while (
      end + 1 < lines.length &&
      (lines[end + 1] ?? '').trim() !== '' &&
      !(lines[end + 1] ?? '').startsWith('# ===')
    ) {
      end += 1;
    }
    backupOnce(file);
    lines.splice(start, end - start + 1, ...mcpBlock(repo).trimEnd().split('\n'));
    writeFileSync(file, lines.join('\n'), 'utf8');
    console.log('MCP：条目已更新（覆盖旧配置）');
    return;
  }
  if (!text.includes(MCP_END_MARK)) throw new Error(`配置结构变了：找不到 ${MCP_END_MARK}`);
  backupOnce(file);
  writeFileSync(file, text.replace(MCP_END_MARK, `${mcpBlock(repo)}${MCP_END_MARK}`), 'utf8');
  console.log('MCP：已挂载 memlattice（stdio + 本地 SQLite）');
}

/* ------------------------------------------------------- main */

function main(): void {
  const command = process.argv[2] ?? 'status';
  const repo = repoRoot();

  if (command === 'apply') {
    const dir = charDir();
    // 先停注入，再给工具：顺序反了会有一段时间"旧记忆没了、新记忆也取不到"
    disable(dir);
    setTimerEnv('1');
    patchWhitelist(repo, true);
    patchMcp(true, SELF_ROOT);
    console.log('\n完成。重启 DSH（含 QQ 桥接）后生效：');
    console.log('  - 会话开头不再注入人格与记忆');
    console.log('  - QQ/B站 会话里会多出 mcp__memlattice__* 工具，AI 自己去取');
    console.log('  - 数据落在 ~/.memlattice/data/memlattice.db，与远端那台互不相干');
    return;
  }

  if (command === 'revert') {
    patchWhitelist(repo, false);
    patchMcp(false, SELF_ROOT);
    setTimerEnv(null);
    restore(charDir());
    console.log('\n还原完成，重启 DSH 生效。');
    return;
  }

  const wl = readFileSync(join(repo, 'plugins', 'surfcore', 'qq-tool-restrict.mjs'), 'utf8');
  const mcpText = readFileSync(profilePatch(), 'utf8');
  const dir = charDir();
  console.log(`白名单含 ${TOOL_PREFIX}：${wl.includes(`'${TOOL_PREFIX}'`)}`);
  console.log(`MCP 已挂载：${mcpText.includes(`id: ${MCP_ID}`)}`);
  console.log(`注入已停：${existsSync(join(dir, '.detach-backup'))}`);
  console.log(`写入定时器已停：${timerEnvValue() === '1'}`);
  console.log(`角色目录：${dir}`);
  const dbPath = join(homedir(), '.memlattice', 'data', 'memlattice.db');
  console.log(`本地库：${dbPath}${existsSync(dbPath) ? '（已存在）' : '（首次启动时创建）'}`);
}

try {
  main();
} catch (err) {
  console.error('失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
