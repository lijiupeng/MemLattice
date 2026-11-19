#!/usr/bin/env node
/**
 * 编译 + 校验 + 提交 + 推送
 *
 * 为什么用 node 而不是 .ps1：Windows 默认执行策略会拦脚本，node 不用改策略。
 *
 * 用法：
 *   npm run ship -- "fix: 修一个东西"          # 全套：类型 → 单测 → 构建 → SQLite 冒烟 → 提交 → 推送
 *   npm run ship -- "msg" --skip-test          # 跳过单测与冒烟
 *   npm run ship -- "msg" --dry                # 只跑编译校验，不提交、不推送
 *   npm run ship -- "msg" --pack               # 额外重打组合包（pack:runtime + npm pack）
 *   npm run ship -- "msg" --wait               # 推完等 45 秒验一次线上健康
 *
 * 退出码：任一步失败即停，不会带着编译错误提交。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const message = argv.find((a) => !a.startsWith('--') && a.trim().length > 0);

const skipTest = has('skip-test');
const dry = has('dry');
const pack = has('pack');
const wait = has('wait');

/**
 * 只有 npm / npx 在 Windows 上是 .cmd，需要经过 shell；
 * git 走 shell 时中文与全角标点的参数会被 cmd 重新解析，提交信息里带中文就会失败。
 */
function needsShell(command) {
  return process.platform === 'win32' && (command === 'npm' || command === 'npx');
}

function run(label, command, args, cwd = process.cwd()) {
  process.stdout.write(`\n\x1b[36m==> ${label}\x1b[0m\n`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: needsShell(command),
    env: process.env,
  });
  if (result.status !== 0) {
    process.stderr.write(`\n\x1b[31m✗ ${label} 失败（退出码 ${result.status}），已中止\x1b[0m\n`);
    process.exit(result.status ?? 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: needsShell(command),
  });
  return { code: result.status ?? 1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

/* ---------------------------------------------------------------- 前置检查 */

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch.code !== 0) {
  process.stderr.write('不在 git 仓库里\n');
  process.exit(1);
}
const current = branch.out;

const dirty = capture('git', ['status', '--porcelain']);
if (!dirty.out) {
  process.stdout.write('\x1b[33m工作区没有改动，只跑编译校验。\x1b[0m\n');
}

process.stdout.write(`分支：\x1b[1m${current}\x1b[0m\n`);
if (current !== 'master' && !dry) {
  process.stdout.write(
    `\x1b[33m注意：当前不是 master。若 gogs 只在 master 上自动部署，这次推送不会触发。\x1b[0m\n`,
  );
}

/* ---------------------------------------------------------------- 校验与构建 */

run('类型检查（前后端）', 'npm', ['run', 'typecheck']);

if (!skipTest) {
  run('单元测试', 'npx', ['vitest', 'run']);
  run('SQLite 全链路冒烟', 'npm', ['run', 'smoke:sqlite']);
}

run('构建（后端 + 前端）', 'npm', ['run', 'build:all']);

if (pack) {
  run('打包运行时', 'npm', ['run', 'pack:runtime', '--', '--clean', '--with-web']);
  const packDir = join(process.cwd(), 'dsh', 'pack');
  if (existsSync(packDir)) run('生成 tgz', 'npm', ['pack'], packDir);
}

if (dry) {
  process.stdout.write('\n\x1b[32m✓ 校验通过（--dry 模式，未提交）\x1b[0m\n');
  process.exit(0);
}

/* ---------------------------------------------------------------- 提交与推送 */

if (dirty.out) {
  const text = message ?? `chore: 自动提交 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  run('暂存改动', 'git', ['add', '-A']);
  run('提交', 'git', ['commit', '-m', text]);
} else {
  process.stdout.write('\n\x1b[33m没有改动，跳过提交\x1b[0m\n');
}

const ahead = capture('git', ['rev-list', '--count', `origin/${current}..${current}`]);
if (ahead.code === 0 && Number(ahead.out) === 0) {
  process.stdout.write('\n\x1b[33m没有待推送的提交\x1b[0m\n');
  process.exit(0);
}

run('推送', 'git', ['push', 'origin', current]);

if (wait) {
  process.stdout.write('\n\x1b[36m等 45 秒后验一次线上健康…\x1b[0m\n');
  spawnSync('node', ['-e', 'setTimeout(()=>{},45000)'], { stdio: 'inherit' });
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const health = capture('curl', ['-s', '-o', nullDevice, '-w', '%{http_code}', 'http://www.muzii.cn:8787/api/health']);
  process.stdout.write(`health = ${health.out}\n`);
}

process.stdout.write('\n\x1b[32m✓ 完成\x1b[0m\n');
