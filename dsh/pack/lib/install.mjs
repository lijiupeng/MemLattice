import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataDir,
  hasBlock,
  installRoot,
  profilePatchPath,
  removeBlock,
  renderBlock,
  resolveProfile,
  skillsRoot,
  upsertBlock,
  versionDir,
} from './dsh.mjs';
import { probe } from './probe.mjs';

export function readRuntimeVersion(runtimeDir) {
  const pkgPath = join(runtimeDir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`运行时目录不完整，缺少 package.json：${runtimeDir}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.version) throw new Error('运行时 package.json 缺少 version 字段');
  return pkg.version;
}

function assertRuntime(runtimeDir) {
  if (!existsSync(join(runtimeDir, 'dist', 'mcp-stdio.js'))) {
    throw new Error(`运行时缺少 dist/mcp-stdio.js：${runtimeDir}\n先在仓库里执行 npm run build，或确认下载的包完整。`);
  }
  if (!existsSync(join(runtimeDir, 'migrations', 'sqlite'))) {
    throw new Error(`运行时缺少 migrations/sqlite：${runtimeDir}\n迁移是启动必需项，缺了 MCP 会直接退出。`);
  }
}

export async function install(options) {
  const { runtimeDir, profile: requestedProfile, scope = 'user', project, skipProbe = false, log = () => {} } = options;
  const profile = resolveProfile(requestedProfile);

  assertRuntime(runtimeDir);
  const version = readRuntimeVersion(runtimeDir);

  const target = versionDir(version);
  log(`安装运行时 ${version} → ${target}`);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(runtimeDir, target, { recursive: true });

  // 配置里必须写安装后的路径：MCP 子进程的工作目录不确定，指回源目录等于别人装上就坏
  const entry = join(target, 'dist', 'mcp-stdio.js');
  const migrations = join(target, 'migrations', 'sqlite');
  const webDir = join(target, 'web', 'dist');
  const sqlitePath = join(dataDir(), 'memlattice.db');
  mkdirSync(dataDir(), { recursive: true });

  if (!skipProbe) {
    // 探活直接打正式库：一次启动同时完成连通性验证和建库，装完即可用
    log('探活：拉起 stdio、跑迁移并调用 memory.start');
    const result = await probe({
      entry,
      env: { SQLITE_PATH: sqlitePath, MIGRATIONS_DIR: migrations, DB_DIALECT: 'sqlite' },
    });
    if (!result.ok) {
      throw new Error(`探活失败：${result.reason}\n${result.stderr ?? ''}`);
    }
    log(result.recallId == null ? '探活通过（空库，首次启动会建常驻块）' : `探活通过（recall_id=${result.recallId}）`);
  }

  // 播种使用说明书：安装时做一次。库已有内容就跳过，不覆盖用户自己写的技能
  const seed = spawnSync(process.execPath, [join(target, 'dist', 'seed-cli.js')], {
    env: {
      ...process.env,
      SQLITE_PATH: sqlitePath,
      MIGRATIONS_DIR: migrations,
      DB_DIALECT: 'sqlite',
    },
    encoding: 'utf8',
  });
  if (seed.status === 0) {
    const lastLine = String(seed.stdout ?? '').trim().split('\n').filter(Boolean).pop();
    log(lastLine || '使用说明书已就绪');
  } else {
    log(`播种跳过：${String(seed.stderr ?? '').trim().slice(0, 200) || '未知原因'}`);
  }

  const patchFile = profilePatchPath(profile);
  upsertBlock(
    patchFile,
    renderBlock({ entry, sqlitePath, migrationsDir: migrations, webDir }),
  );

  const skillSource = join(target, 'dsh', 'memlattice');
  const skillTarget = join(skillsRoot({ scope, project }), 'memlattice');
  let skillInstalled = null;
  if (existsSync(join(skillSource, 'SKILL.md'))) {
    if (existsSync(skillTarget)) rmSync(skillTarget, { recursive: true, force: true });
    mkdirSync(skillTarget, { recursive: true });
    cpSync(skillSource, skillTarget, { recursive: true });
    skillInstalled = skillTarget;
  }

  return { version, profile, runtime: target, entry, sqlitePath, patchFile, skill: skillInstalled, migrations };
}

export function uninstall({ profile: requestedProfile, scope = 'user', project, purge = false, log = () => {} }) {
  const patchFile = profilePatchPath(resolveProfile(requestedProfile));
  const removed = removeBlock(patchFile);

  const skillTarget = join(skillsRoot({ scope, project }), 'memlattice');
  const skillRemoved = existsSync(skillTarget);
  if (skillRemoved) rmSync(skillTarget, { recursive: true, force: true });

  let runtimeRemoved = false;
  if (purge) {
    runtimeRemoved = existsSync(installRoot());
    if (runtimeRemoved) rmSync(installRoot(), { recursive: true, force: true });
  }

  log(removed ? `已从 ${patchFile} 移除 MCP 配置` : `${patchFile} 中没有 memlattice 配置`);
  log(skillRemoved ? `已移除技能：${skillTarget}` : '未发现已安装的技能');
  if (purge) log(runtimeRemoved ? `已删除运行时与数据：${installRoot()}` : '未发现运行时目录');
  else log(`运行时与记忆数据保留在 ${installRoot()}（加 --purge 一并删除）`);

  return { removed, skillRemoved, runtimeRemoved };
}

export function doctor({ profile: requestedProfile, scope = 'user', project }) {
  const patchFile = profilePatchPath(resolveProfile(requestedProfile));
  const checks = [];
  checks.push({ name: 'patch 文件存在', ok: existsSync(patchFile), detail: patchFile });
  checks.push({ name: 'MCP 配置行已写入', ok: hasBlock(patchFile), detail: patchFile });

  const root = installRoot();
  checks.push({ name: '运行时目录存在', ok: existsSync(root), detail: root });

  const db = join(dataDir(), 'memlattice.db');
  checks.push({ name: '记忆库已初始化', ok: existsSync(db), detail: db });

  const skillTarget = join(skillsRoot({ scope, project }), 'memlattice');
  checks.push({ name: '技能已安装', ok: existsSync(join(skillTarget, 'SKILL.md')), detail: skillTarget });

  return checks;
}
