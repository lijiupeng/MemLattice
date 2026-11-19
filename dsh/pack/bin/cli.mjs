#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, uninstall, doctor } from '../lib/install.mjs';
import { serve } from '../lib/serve.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIN_NODE_MAJOR = 22;

const USAGE = `
dsh-memlattice — 把 MemLattice 接进 DeepSeek Harness

用法：
  dsh-memlattice install   [--profile web] [--scope user|project] [--project <目录>]
                           [--runtime <目录>] [--skip-probe]
  dsh-memlattice uninstall [--profile web] [--scope user|project] [--project <目录>] [--purge]
  dsh-memlattice doctor    [--profile web] [--scope user|project] [--project <目录>]
  dsh-memlattice serve     启动 MCP 服务端（由 DSH 调用，不要手动执行）
  dsh-memlattice web [端口] 打开 Web 控制台（默认 8787，和 serve 共用同一个本地库）

  dsh-memlattice prompt-split --file <提示词.txt> [--apply]   QQ 提示词分类 / 落库
  dsh-memlattice bridge import|export|sync [--char <目录>] [--persona]   角色包 ⇄ 记忆库
  dsh-memlattice prompt-off apply|revert|status              关掉 SurfCore 的人格与记忆注入
  dsh-memlattice detach disable|restore|status               只清 / 还原人格与记忆文件

说明：
  --profile    目标 DSH profile，默认自动探测（只有一个 profile 时直接用它）
  --runtime    指定运行时目录（含 dist/ 与 migrations/），默认用包内自带的 runtime/
  --purge      uninstall 时连运行时与记忆数据一起删除，默认保留
  --skip-probe 跳过装完的连通性检查，仅在排障时用
`;

function parseArgs(argv) {
  const options = { scope: 'user', skipProbe: false, purge: false };
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift();
    switch (token) {
      case '--profile':
        options.profile = rest.shift();
        break;
      case '--scope':
        options.scope = rest.shift() ?? options.scope;
        break;
      case '--project':
        options.project = rest.shift();
        break;
      case '--runtime':
        options.runtime = rest.shift();
        break;
      case '--skip-probe':
        options.skipProbe = true;
        break;
      case '--purge':
        options.purge = true;
        break;
      default:
        throw new Error(`未知参数：${token}`);
    }
  }
  if (!['user', 'project'].includes(options.scope)) {
    throw new Error('--scope 只能是 user 或 project');
  }
  return options;
}

function log(message) {
  process.stdout.write(`  ${message}\n`);
}

function step(message) {
  process.stdout.write(`==> ${message}\n`);
}

async function main() {
  const [, , command, ...argv] = process.argv;

  if (!command || ['-h', '--help', 'help'].includes(command)) {
    process.stdout.write(USAGE);
    return;
  }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node 版本过低（${process.versions.node}），MemLattice 需要 >= ${MIN_NODE_MAJOR}`);
  }

  // serve 由 DSH 的 MCP client 直接拉起：走 stdio 协议，不能解析参数，也不能往 stdout 写任何东西
  if (command === 'serve') {
    await serve(PACKAGE_ROOT);
    return;
  }

  // Web 控制台：和 serve 共用同一个本地库，只是入口换成 HTTP 那个
  if (command === 'web') {
    const runtime = fileURLToPath(new URL('../runtime/', import.meta.url));
    const entry = join(runtime, 'dist', 'index.js');
    if (!existsSync(entry)) {
      throw new Error(`运行时缺少 ${entry}\n重新安装（dsh-memlattice install）后再试`);
    }
    const port = argv[0] && !argv[0].startsWith('-') ? argv[0] : (process.env.PORT ?? '8787');
    const token = process.env.MEMLATTICE_TOKEN ?? 'dev-token-change-me';
    process.stdout.write(`\nMemLattice 控制台：http://127.0.0.1:${port}/\n令牌：${token}\n按 Ctrl+C 停止\n\n`);
    const child = spawn(process.execPath, [entry], {
      stdio: 'inherit',
      env: {
        ...process.env,
        DB_DIALECT: process.env.DB_DIALECT ?? 'sqlite',
        SQLITE_PATH: process.env.SQLITE_PATH ?? join(homedir(), '.memlattice', 'data', 'memlattice.db'),
        MIGRATIONS_DIR: process.env.MIGRATIONS_DIR ?? join(runtime, 'migrations', 'sqlite'),
        WEB_DIR: process.env.WEB_DIR ?? join(runtime, 'web', 'dist'),
        PORT: port,
        MEMLATTICE_TOKEN: token,
      },
    });
    await new Promise((done) => child.on('exit', done));
    process.exitCode = child.exitCode ?? 0;
    return;
  }

  // 运维脚本：参数原样透传，不吃上面那套 install/uninstall 的解析
  const scriptCommands = {
    'prompt-split': 'qq-prompt-split.mjs',
    'prompt-off': 'surfcore-prompt-off.mjs',
    bridge: 'surfcore-bridge.mjs',
    detach: 'surfcore-detach.mjs',
  };
  if (scriptCommands[command]) {
    const script = join(PACKAGE_ROOT, 'runtime', 'scripts', scriptCommands[command]);
    if (!existsSync(script)) {
      throw new Error(`运行时缺少脚本：${script}\n重新安装（dsh-memlattice install）后再试`);
    }
    const child = spawn(process.execPath, [script, ...argv], {
      stdio: 'inherit',
      env: {
        ...process.env,
        DB_DIALECT: process.env.DB_DIALECT ?? 'sqlite',
        SQLITE_PATH: process.env.SQLITE_PATH ?? join(homedir(), '.memlattice', 'data', 'memlattice.db'),
        MIGRATIONS_DIR: process.env.MIGRATIONS_DIR ?? join(PACKAGE_ROOT, 'runtime', 'migrations', 'sqlite'),
      },
    });
    await new Promise((done) => child.on('exit', done));
    process.exitCode = child.exitCode ?? 0;
    return;
  }

  const options = parseArgs(argv);

  if (command === 'install') {
    const runtimeDir = options.runtime ?? fileURLToPath(new URL('../runtime/', import.meta.url));
    step('安装 MemLattice');
    const result = await install({ ...options, runtimeDir, log });
    process.stdout.write('\n完成。\n');
    log(`DSH profile：${result.profile}`);
    log(`运行时：${result.runtime}`);
    log(`记忆库：${result.sqlitePath}`);
    log(`MCP 配置：${result.patchFile}`);
    if (result.skill) log(`技能：${result.skill}`);
    process.stdout.write('\n重启 DSH 网关后，在设置 → MCP 里应能看到 memlattice。\n');
    return;
  }

  if (command === 'uninstall') {
    step('卸载 MemLattice');
    uninstall({ ...options, log });
    return;
  }

  if (command === 'doctor') {
    step('自检');
    const checks = doctor(options);
    for (const check of checks) {
      process.stdout.write(`  ${check.ok ? 'OK  ' : 'FAIL'}  ${check.name}  ${check.detail}\n`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((err) => {
  process.stderr.write(`\n安装失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
