import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, dshHome } from './dsh.mjs';

/**
 * 由 DSH 的 MCP client 拉起（`dsh-memlattice serve`）。
 * 路径全部在这里算：配置层里就不必写任何绝对路径，换机器、换用户名都不用改配置。
 * stdout 属于 MCP 协议，本进程只允许往 stderr 写日志。
 */
export async function serve(packageRoot) {
  const runtime = join(packageRoot, 'runtime');
  const entry = join(runtime, 'dist', 'mcp-stdio.js');
  if (!existsSync(entry)) {
    process.stderr.write(`[memlattice] 包内运行时缺失：${entry}\n`);
    process.exit(1);
  }

  mkdirSync(dataDir(), { recursive: true });
  process.env.SQLITE_PATH ??= join(dataDir(), 'memlattice.db');
  process.env.MIGRATIONS_DIR ??= join(runtime, 'migrations', 'sqlite');
  process.env.WEB_DIR ??= join(runtime, 'web', 'dist');
  process.env.DB_DIALECT ??= 'sqlite';
  // DSH 用原生 skills 加载技能，不需要 CodeBuddy 那套会话钩子自检
  process.env.HOOK_CHECK ??= 'off';

  syncSkill(join(runtime, 'dsh', 'memlattice'), join(dshHome(), 'skills', 'memlattice'));

  await import(pathToFileURL(entry).href);
}

/** 技能跟着包走：内容没变就不动文件，避免每次启动都触发 DSH 的技能 watcher。 */
function syncSkill(source, target) {
  const sourceFile = join(source, 'SKILL.md');
  if (!existsSync(sourceFile)) return;

  const targetFile = join(target, 'SKILL.md');
  if (existsSync(targetFile) && readFileSync(targetFile, 'utf8') === readFileSync(sourceFile, 'utf8')) {
    return;
  }

  try {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
  } catch (err) {
    process.stderr.write(`[memlattice] 技能同步失败（不影响 MCP）：${err instanceof Error ? err.message : err}\n`);
  }
}
