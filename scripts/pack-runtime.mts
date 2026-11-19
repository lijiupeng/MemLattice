#!/usr/bin/env node
/**
 * 组装可分发的运行时目录：dist + 生产依赖 + 迁移 + 技能。
 * 发布包 dsh/pack 只带 JS 壳，真正跑起来的是这份产物，所以它必须自包含、不依赖仓库。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const withWeb = args.includes('--with-web');
const clean = args.includes('--clean');
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1] ?? '') : join(repoRoot, 'dsh', 'pack', 'runtime');

function fail(message: string): never {
  console.error(`打包失败：${message}`);
  process.exit(1);
}

function runNpm(step: string, npmArgs: string[], cwd: string): void {
  console.log(`==> ${step}`);
  const result = spawnSync('npm', npmArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail(`${step} 退出码 ${result.status}`);
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

for (const required of ['dist/index.js', 'dist/mcp-stdio.js', 'migrations/sqlite']) {
  if (!existsSync(join(repoRoot, required))) fail(`缺少 ${required}，先执行 npm run build`);
}
if (withWeb && !existsSync(join(repoRoot, 'web', 'dist'))) fail('缺少 web/dist，先执行 npm run web:build');

const source = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;

// 两个版本号决定安装目录和 npm 包版本，不一致会装出对不上的组合
const packManifest = JSON.parse(
  readFileSync(join(repoRoot, 'dsh', 'pack', 'package.json'), 'utf8'),
) as { version?: string };
if (packManifest.version !== source.version) {
  fail(`dsh/pack 版本 ${packManifest.version} 与主包 ${String(source.version)} 不一致，先对齐再打包`);
}

// 默认覆盖写入：某些环境对大批量删除有限流，--clean 留给 CI 或确定要重来时用
if (existsSync(outDir) && clean) {
  rmSync(outDir, { recursive: true, force: true });
} else if (existsSync(outDir)) {
  console.log('==> 目标目录已存在，覆盖写入（要彻底重来加 --clean）');
}
mkdirSync(outDir, { recursive: true });

console.log(`==> 拷贝运行时代码 → ${outDir}`);
for (const entry of ['dist', 'migrations', 'LICENSE', 'README.md']) {
  if (existsSync(join(repoRoot, entry))) {
    cpSync(join(repoRoot, entry), join(outDir, entry), { recursive: true });
  }
}
cpSync(join(repoRoot, 'dsh', 'memlattice'), join(outDir, 'dsh', 'memlattice'), { recursive: true });
if (withWeb) cpSync(join(repoRoot, 'web', 'dist'), join(outDir, 'web', 'dist'), { recursive: true });

/**
 * 运维脚本转译进 runtime/scripts。
 * 装进包以后没有 src/ 也没有 tsx，所以这里转成 .mjs，并把对源码的引用改到 dist/。
 */
const SCRIPT_NAMES = ['qq-prompt-split', 'surfcore-bridge', 'surfcore-prompt-off', 'surfcore-detach'];
{
  const outScripts = join(outDir, 'scripts');
  mkdirSync(outScripts, { recursive: true });
  for (const name of SCRIPT_NAMES) {
    const src = join(repoRoot, 'scripts', `${name}.mts`);
    if (!existsSync(src)) fail(`缺少脚本 ${src}`);
    const code = transformSync(readFileSync(src, 'utf8'), {
      loader: 'ts',
      format: 'esm',
      target: 'node22',
    }).code;
    writeFileSync(join(outScripts, `${name}.mjs`), code.replaceAll('../src/', '../dist/'), 'utf8');
  }
  console.log(`==> 运维脚本 ${SCRIPT_NAMES.length} 个 → ${outScripts}`);
}

// 精简清单：只留运行时需要的信息，devDependencies 不进产物
const runtimeManifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  license: source.license,
  type: source.type,
  engines: source.engines,
  dependencies: source.dependencies ?? {},
  optionalDependencies: source.optionalDependencies ?? {},
};
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`, 'utf8');

runNpm('安装生产依赖', ['install', '--omit=dev', '--no-audit', '--no-fund'], outDir);
rmSync(join(outDir, 'package-lock.json'), { force: true });

const megabytes = (dirSize(outDir) / 1024 / 1024).toFixed(1);
console.log(`==> 完成：${outDir}（${megabytes} MB）`);
