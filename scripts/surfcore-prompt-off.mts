/* eslint-disable no-console */
/**
 * 关掉 SurfCore 在 QQ 提示词里拼的人格与记忆，改成一句「去 MCP 取」
 *
 * 清空文件只能解决「内容从哪读」，解决不了「代码无条件往里拼」：
 *   roleLine        【当前角色】<current.json 的 name>
 *   identity        你是 <昵称>；你的主人是 <主人>……   ← buildPersonaIdentity 生成
 *   adminBlock      管理员规则
 * 这三段都不读人格文件，只能改调用点。
 *
 * 做法：给 bridge.js 的两个入口加一个提前返回，靠环境变量控制，
 * 不改原有逻辑——想退回只需清掉变量，不会留下半坏的状态。
 *
 * 用法：
 *   npx tsx scripts/surfcore-prompt-off.mts apply  [--repo <dir>]
 *   npx tsx scripts/surfcore-prompt-off.mts revert [--repo <dir>]
 *   npx tsx scripts/surfcore-prompt-off.mts status [--repo <dir>]
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ENV_NAME = 'SURFCORE_PROMPT_OFF';
const MARK = '// [memlattice] prompt-off';
const BAK_SUFFIX = '.bak-memlattice-prompt';
const FLAG_NAME = 'prompt-off.flag';
const PROMPT =
  '【人格与记忆】调用 mcp__memlattice__memory.start 获取；qq_get_prompt 已停用，不要再调用它。';

interface Patch {
  anchor: string;
  injected: string;
  note: string;
}

function flagPath(repo: string): string {
  return join(repo, 'state', FLAG_NAME);
}

/**
 * 开关用文件而不是环境变量：
 * setx 只写注册表，对已经跑着的 DSH 和它拉起的桥接不生效，
 * 之前踩过这个坑——补丁打上了、进程也重启了，但条件永远不成立。
 */
function cond(repo: string): string {
  return `fs.existsSync(${JSON.stringify(flagPath(repo))})`;
}

function buildPatches(repo: string): Patch[] {
  const c = cond(repo);
  return [
    {
      anchor: "function roleHintForMode(mode, key = '', personaMode = '', opts = {}) {",
      injected: `  ${MARK}\n  if (${c}) return ${JSON.stringify(PROMPT)};`,
      note: 'roleHintForMode：人格卡 / 管理员规则 / B站记忆 / 记忆卡 / 语音状态的总入口',
    },
    {
      anchor: "function currentRoleHintV2(key = '', personaMode = '') {",
      injected: `  ${MARK}\n  if (${c}) return ${JSON.stringify(PROMPT)};`,
      note: 'currentRoleHintV2：v2 唤醒提示用，这里也拦一次，避免被逐行过滤掉',
    },
    {
      anchor: "function purposeContextBlocks(key = '') {",
      injected: `  ${MARK}\n  if (${c}) return [${JSON.stringify(PROMPT)}];`,
      note: 'purposeContextBlocks：主动搭话走这条，同样只留指令',
    },
  ];
}

/**
 * 唤醒提示的最终拼装在 buildWakePromptV2 里，那一行把二十多段串起来。
 * 前面几处只能改「角色段写什么」，改不掉反AI味 / 积极性 / 来源判断这些平级段，
 * 所以这里直接把整行换成分支：关掉时只留令牌、状态、唤醒配置这些跑起来必需的东西。
 */
const BASE_LINE_RE = /const base = (roleLine \+ [^;]+);/;

function patchBaseLine(text: string, repo: string): string {
  if (!BASE_LINE_RE.test(text)) {
    throw new Error('锚点没找到：buildWakePromptV2 里的 base 拼装行');
  }
  return text.replace(
    BASE_LINE_RE,
    (_m, expr: string) =>
      `${MARK}\n    const base = ${cond(repo)}\n` +
      `      ? (${JSON.stringify(PROMPT)} + '\\n\\n' + tokenLine + statusLine + wakeLine)\n` +
      `      : (${expr});`,
  );
}

function argv(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function repoRoot(): string {
  const explicit = argv('repo') ?? process.env.SURFCORE_HOME;
  if (explicit) return resolve(explicit);
  const guess = join(homedir(), 'surfcore');
  if (!existsSync(guess)) throw new Error('找不到 surfcore 仓库，用 --repo <dir> 指定');
  return guess;
}

function bridgeFile(repo: string): string {
  const file = join(repo, 'src', 'bridge.js');
  if (!existsSync(file)) throw new Error(`找不到 ${file}`);
  return file;
}

function apply(repo: string): void {
  const file = bridgeFile(repo);
  const text = readFileSync(file, 'utf8');
  writeFlag(repo);
  if (text.includes(MARK)) {
    console.log('补丁已在，开关已重新打开（不需要重启）');
    return;
  }
  let next = text;
  for (const patch of buildPatches(repo)) {
    if (!next.includes(patch.anchor)) {
      throw new Error(`锚点没找到（源码可能已更新）：${patch.anchor.slice(0, 60)}…`);
    }
    next = next.replace(patch.anchor, `${patch.anchor}\n${patch.injected}`);
    console.log(`已注入：${patch.note}`);
  }
  next = patchBaseLine(next, repo);
  console.log('已注入：buildWakePromptV2 的 base 拼装行（关掉时只留令牌 / 状态 / 唤醒配置）');
  copyFileSync(file, `${file}${BAK_SUFFIX}`);
  writeFileSync(file, next, 'utf8');
  console.log(`\n开关文件：${flagPath(repo)}`);
  console.log('\n重启 DSH（含 QQ 桥接）后生效。');
  console.log('之后唤醒提示里只剩一句「去 mcp__memlattice__memory.start 取」。');
}

function writeFlag(repo: string): void {
  const dir = join(repo, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    flagPath(repo),
    `由 surfcore-prompt-off 于 ${new Date().toISOString()} 创建；删掉此文件即可恢复注入。\n`,
    'utf8',
  );
}

function revert(repo: string): void {
  const file = bridgeFile(repo);
  const bak = `${file}${BAK_SUFFIX}`;
  if (!existsSync(bak)) {
    console.log('没有备份，跳过还原');
  } else {
    copyFileSync(bak, file);
    console.log('bridge.js 已还原');
  }
  if (existsSync(flagPath(repo))) {
    rmSync(flagPath(repo), { force: true });
    console.log('开关文件已删除');
  }
  console.log('\n重启 DSH 生效。');
}

function currentEnv(): string {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${ENV_NAME}','User')`],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '';
  }
}

/** 桥接进程的启动时间：晚于 bridge.js 的修改时间，才说明它加载了补丁 */
function bridgeProcess(): { pid: string; started: string } | null {
  try {
    const cmd =
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*bridge*' } | " +
      'Select-Object -First 1 ProcessId,CreationDate | ConvertTo-Json -Compress';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
    }).trim();
    if (!out) return null;
    const parsed = JSON.parse(out) as { ProcessId?: number; CreationDate?: string };
    if (!parsed.ProcessId) return null;
    return { pid: String(parsed.ProcessId), started: String(parsed.CreationDate ?? '') };
  } catch {
    return null;
  }
}

function status(repo: string): void {
  const file = bridgeFile(repo);
  const text = readFileSync(file, 'utf8');
  const patched = text.includes(MARK);
  const mtime = statSync(file).mtime;
  console.log(`仓库：${repo}`);
  console.log(`bridge.js 已打补丁：${patched}`);
  console.log(`环境变量 ${ENV_NAME}：${currentEnv() || '(空)'}`);
  console.log(`备份文件：${existsSync(`${file}${BAK_SUFFIX}`) ? '有' : '无'}`);
  console.log(
    `开关文件：${existsSync(flagPath(repo)) ? '存在（注入已关闭）' : '不存在（注入照常）'}`,
  );
  console.log(`bridge.js 修改时间：${mtime.toLocaleString()}`);

  const proc = bridgeProcess();
  if (!proc) {
    console.log('桥接进程：未运行（下次启动即生效）');
    return;
  }
  // CreationDate 在 JSON 里是 /Date(ms)/ 或 ISO，取其中数字最稳
  const ms = Number((proc.started.match(/\d{10,}/) ?? [])[0] ?? 0);
  const started = ms > 0 ? new Date(ms) : null;
  console.log(`桥接进程：PID ${proc.pid}，启动于 ${started ? started.toLocaleString() : proc.started}`);
  if (started && started.getTime() < mtime.getTime()) {
    console.log('\x1b[33m⚠ 进程比补丁旧：它加载的还是旧代码，必须重启桥接\x1b[0m');
  } else if (started) {
    console.log('\x1b[32m✓ 进程晚于补丁，补丁已加载\x1b[0m');
  }
}

const command = process.argv[2] ?? 'status';
const repo = repoRoot();

if (command === 'apply') apply(repo);
else if (command === 'revert') revert(repo);
else if (command === 'status') status(repo);
else {
  console.log('用法：apply | revert | status  [--repo <dir>]');
  process.exitCode = 1;
}
