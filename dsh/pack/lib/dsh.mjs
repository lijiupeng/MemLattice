import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * patch 块用注释做边界标记：YAML 解析器会忽略注释，
 * 但卸载时只有靠它才能精确删掉我们写的行，不碰用户自己的配置。
 */
const MARK_START = '# >>> memlattice managed block — 由 dsh-memlattice 写入，请勿手改';
const MARK_END = '# <<< memlattice managed block';
const ROW_ID = 'mcp-memlattice';

const BLOCK_PATTERN = new RegExp(
  `${escapeRe(MARK_START)}[\\s\\S]*?${escapeRe(MARK_END)}\\n?`,
  'g',
);

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** YAML 单引号字符串：反斜杠不是转义符，所以统一把 Windows 路径转成正斜杠再包。 */
function quote(value) {
  return `'${String(value).replace(/\\/g, '/').replace(/'/g, "''")}'`;
}

export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh');
}

export function profilePatchPath(profile) {
  return join(dshHome(), 'profiles', profile, 'cordis.patch.yml');
}

/**
 * 用户机器上的 profile 名字不固定（web / desktop / tui / headless），
 * 猜错就装到一个永远不启动的目录里，所以有唯一 profile 时直接用它，多个则要求显式指定。
 */
export function resolveProfile(explicit) {
  if (explicit) return explicit;
  const root = join(dshHome(), 'profiles');
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  if (names.length === 1) return names[0];
  if (names.length === 0) return 'web';
  throw new Error(`检测到多个 DSH profile（${names.join('、')}），请用 --profile 指定其中一个`);
}

export function skillsRoot({ scope = 'user', project } = {}) {
  if (scope === 'project') {
    if (!project) throw new Error('--scope project 需要同时指定 --project <项目目录>');
    return join(resolve(project), '.dsh', 'skills');
  }
  return join(dshHome(), 'skills');
}

export function installRoot() {
  return join(homedir(), '.memlattice');
}

export function dataDir() {
  return join(installRoot(), 'data');
}

export function versionDir(version) {
  return join(installRoot(), 'versions', version);
}

export function renderBlock({ entry, sqlitePath, migrationsDir, webDir }) {
  return [
    MARK_START,
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: stdio',
    '        serverName: memlattice',
    '        command: node',
    '        args:',
    `          - ${quote(entry)}`,
    '        env:',
    `          SQLITE_PATH: ${quote(sqlitePath)}`,
    `          MIGRATIONS_DIR: ${quote(migrationsDir)}`,
    `          WEB_DIR: ${quote(webDir)}`,
    "          DB_DIALECT: 'sqlite'",
    "          HOOK_CHECK: 'off'",
    MARK_END,
    '',
  ].join('\n');
}

/** 幂等写入：先摘掉旧块再追加，重复安装不会叠出两份。 */
export function upsertBlock(file, block) {
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const stripped = previous.replace(BLOCK_PATTERN, '').replace(/\s*$/, '');
  const next = stripped ? `${stripped}\n\n${block}` : block;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next, 'utf8');
  return { created: !previous };
}

export function removeBlock(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  if (!text.includes(MARK_START)) return false;
  const next = text.replace(BLOCK_PATTERN, '').replace(/\s*$/, '');
  writeFileSync(file, next ? `${next}\n` : '', 'utf8');
  return true;
}

export function hasBlock(file) {
  return existsSync(file) && readFileSync(file, 'utf8').includes(MARK_START);
}
