import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { closeSql, createSql, type Sql } from './client.js';

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migration (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const MIGRATION_TABLE_SQLITE = `
CREATE TABLE IF NOT EXISTS schema_migration (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`;

function migrationTable(sql: Sql): string {
  return sql.dialect === 'sqlite' ? MIGRATION_TABLE_SQLITE : MIGRATION_TABLE;
}

function upFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

/**
 * SQLite 的迁移是「整份脚本跑一次就记一笔」：001 应用过就不会再跑。
 * 后来往 001 里补的列，老库永远补不上——查询一用到就 E_INTERNAL。
 * SQLite 又没有 ADD COLUMN IF NOT EXISTS，只能启动时按需 ALTER。
 * 以后往 001 里加列，记得同步加到这里。
 */
const SQLITE_REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'mem_card', column: 'hit_count', ddl: 'INTEGER NOT NULL DEFAULT 0' },
];

async function ensureSqliteColumns(sql: Sql, log: (msg: string) => void): Promise<void> {
  if (sql.dialect !== 'sqlite') return;
  for (const item of SQLITE_REQUIRED_COLUMNS) {
    // unsafe 走 db.exec，拿不到 PRAGMA 结果；直接改，重复列当成功
    try {
      await sql.unsafe(`ALTER TABLE ${item.table} ADD COLUMN ${item.column} ${item.ddl}`);
      log(`补齐列 ${item.table}.${item.column}`);
    } catch (err) {
      const message = String((err as Error)?.message ?? '');
      if (/duplicate column name/i.test(message)) continue;
      throw err;
    }
  }
}

export async function migrateUp(sql: Sql, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  await sql.unsafe(migrationTable(sql));
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migration ORDER BY name`;
  const applied = new Set(rows.map((r) => r.name));
  const done: string[] = [];
  for (const file of upFiles(dir)) {
    if (applied.has(file)) continue;
    const body = readFileSync(join(dir, file), 'utf8');
    await sql.unsafe(body);
    await sql`INSERT INTO schema_migration (name) VALUES (${file}) ON CONFLICT DO NOTHING`;
    log(`applied ${file}`);
    done.push(file);
  }

  // SQLite 的全量脚本只有 CREATE TABLE/INDEX IF NOT EXISTS，没有 INSERT、ALTER，
  // 重跑一遍是安全的，正好补上老库缺的表（mem_triage 就是这么漏的）。
  // PG 侧靠逐条迁移升级，不走这条。
  if (sql.dialect === 'sqlite' && applied.has('001_init.sql')) {
    const base = join(dir, '001_init.sql');
    if (existsSync(base)) await sql.unsafe(readFileSync(base, 'utf8'));
  }

  await ensureSqliteColumns(sql, log);
  return done;
}

export async function migrateDown(sql: Sql, dir: string, log: (msg: string) => void = () => {}): Promise<string | null> {
  if (sql.dialect === 'sqlite') {
    throw new Error('SQLite 用全量建表脚本，没有逐条回滚；删掉数据文件即可重建');
  }
  await sql.unsafe(MIGRATION_TABLE);
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migration ORDER BY name DESC LIMIT 1`;
  const latest = rows[0];
  if (!latest) return null;
  const downFile = latest.name.replace(/\.sql$/, '.down.sql');
  let body: string;
  try {
    body = readFileSync(join(dir, downFile), 'utf8');
  } catch {
    throw new Error(`缺少回滚脚本：${downFile}`);
  }
  await sql.unsafe(body);
  await sql`DELETE FROM schema_migration WHERE name = ${latest.name}`;
  log(`reverted ${latest.name}`);
  return latest.name;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const sql = createSql(cfg);
  const direction = process.argv[2] ?? 'up';
  try {
    if (direction === 'down') {
      const reverted = await migrateDown(sql, cfg.migrationsDir, (m) => console.log(m));
      console.log(reverted ? `回滚完成：${reverted}` : '没有可回滚的迁移');
    } else {
      const applied = await migrateUp(sql, cfg.migrationsDir, (m) => console.log(m));
      console.log(applied.length ? `已应用 ${applied.length} 个迁移` : '数据库已是最新');
    }
  } finally {
    await closeSql(sql);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
