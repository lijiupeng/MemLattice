import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dialect } from './db/dialect.js';

function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}
function list(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  /** 非空时把结构化日志同时写入该文件（默认只输出到 stdout） */
  logFile: string;
  allowedOrigins: string[];
  authToken: string;
  databaseUrl: string;
  dbMaxConnections: number;
  /** 存储引擎：sqlite 零依赖开箱可用，pg 供已有部署继续使用 */
  dbDialect: Dialect;
  /** sqlite 单文件路径，放不放 DATABASE_URL 都不影响它 */
  sqlitePath: string;
  user: { externalId: string; displayName: string };
  budget: { defaultTokens: number; maxTokens: number; weakHintLimit: number };
  life: {
    termHalfLifeDays: number;
    cardHalfLifeDays: number;
    /** 技能一句话描述上限（进 L1 索引的那一行） */
    skillMaxChars: number;
    /** 技能详细描述上限（memory.expand 按 block_id 取回） */
    skillDetailMaxChars: number;
    /** recall 的经验索引只列热度前 N 条 */
    skillIndexLimit: number;
    skillL1MaxTokens: number;
    l1IdleDemoteDays: number;
    coldHeat: number;
    coldDays: number;
    skeletonMaxChars: number;
    rawArchiveDays: number;
    rawPurgeDays: number;
    trashRestoreDays: number;
    keepHistoryRatio: number;
    recentLimit: number;
    recentTtlDays: number;
  };
  write: {
    condenseTurnThreshold: number;
    condenseMaxAttempts: number;
    /** 不传 event_id 时，复用同 scope 下最近未成卡的 open 事件（分钟）；0 关闭 */
    autoResumeMinutes: number;
    /** 巡检把超过该小时数仍未成卡的 open 事件浓缩或归档；0 关闭 */
    openEventSweepHours: number;
  };
  blocks: {
    /** 这些 label 的非人工写入进入待审队列；留空表示全部直写 */
    approvalLabels: string[];
  };
  worker: { enabled: boolean; hour: number };
  migrationsDir: string;
  webDir: string;
}

/**
 * 显式 DB_DIALECT 优先；都没配时按是否提供了 DATABASE_URL 推断——
 * 配了连接串就当老部署继续用 PG，没配就是本地/单机场景，直接落到 SQLite。
 */
function pickDialect(): Dialect {
  const explicit = (process.env.DB_DIALECT ?? '').trim().toLowerCase();
  if (explicit === 'pg' || explicit === 'postgres') return 'pg';
  if (explicit === 'sqlite' || explicit === 'sqlite3') return 'sqlite';
  const url = process.env.DATABASE_URL;
  return url === undefined || url === '' ? 'sqlite' : 'pg';
}

export function loadConfig(): AppConfig {
  const dialect = pickDialect();
  const cfg: AppConfig = {
    port: num('PORT', 8787),
    host: str('HOST', '0.0.0.0'),
    logLevel: str('LOG_LEVEL', 'info'),
    logFile: str('LOG_FILE', ''),
    allowedOrigins: list('ALLOWED_ORIGINS', ['http://localhost:8787', 'http://127.0.0.1:8787']),
    authToken: str('MEMLATTICE_TOKEN', 'dev-token-change-me'),
    databaseUrl: str('DATABASE_URL', 'postgres://memlattice:memlattice@localhost:5432/memlattice'),
    dbMaxConnections: num('DB_MAX_CONNECTIONS', 10),
    dbDialect: dialect,
    sqlitePath: str('SQLITE_PATH', resolve(process.cwd(), 'data', 'memlattice.db')),
    user: {
      externalId: str('DEFAULT_USER_EXTERNAL_ID', 'default'),
      displayName: str('DEFAULT_USER_DISPLAY_NAME', 'Me'),
    },
    budget: {
      // 与 SurfCore 的 memoryCard.injectMaxChars.qq 对齐：2200 字 ≈ 2200 tokens
      defaultTokens: num('DEFAULT_BUDGET_TOKENS', 2200),
      maxTokens: num('MAX_BUDGET_TOKENS', 4000),
      weakHintLimit: num('WEAK_HINT_LIMIT', 3),
    },
    life: {
      termHalfLifeDays: num('TERM_HALF_LIFE_DAYS', 14),
      cardHalfLifeDays: num('CARD_HALF_LIFE_DAYS', 30),
      skillMaxChars: num('SKILL_MAX_CHARS', 60),
      skillDetailMaxChars: num('SKILL_DETAIL_MAX_CHARS', 4000),
      skillIndexLimit: num('SKILL_INDEX_LIMIT', 5),
      skillL1MaxTokens: num('SKILL_L1_MAX_TOKENS', 400),
      l1IdleDemoteDays: num('L1_IDLE_DEMOTE_DAYS', 90),
      coldHeat: num('COLD_HEAT_THRESHOLD', 0.5),
      coldDays: num('COLD_IDLE_DAYS', 90),
      skeletonMaxChars: num('SKELETON_MAX_CHARS', 80),
      rawArchiveDays: num('RAW_ARCHIVE_AFTER_DAYS', 365),
      rawPurgeDays: num('RAW_PURGE_AFTER_DAYS', 730),
      trashRestoreDays: num('TRASH_RESTORE_DAYS', 7),
      keepHistoryRatio: num('KEEP_HISTORY_CARD_RATIO', 0.1),
      recentLimit: num('RECENT_INDEX_LIMIT', 15),
      recentTtlDays: num('RECENT_INDEX_TTL_DAYS', 7),
    },
    write: {
      condenseTurnThreshold: num('CONDENSE_TURN_THRESHOLD', 12),
      condenseMaxAttempts: num('CONDENSE_MAX_ATTEMPTS', 5),
      autoResumeMinutes: num('WRITE_AUTO_RESUME_MINUTES', 30),
      openEventSweepHours: num('OPEN_EVENT_SWEEP_HOURS', 2),
    },
    blocks: {
      approvalLabels: str('BLOCK_APPROVAL_LABELS', '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item): item is 'persona' | 'rules' | 'skills' =>
          ['persona', 'rules', 'skills'].includes(item),
        ),
    },
    worker: {
      enabled: bool('WORKER_ENABLED', true),
      hour: num('WORKER_HOUR', 3),
    },
    migrationsDir: str(
      'MIGRATIONS_DIR',
      resolve(process.cwd(), 'migrations', dialect === 'sqlite' ? 'sqlite' : ''),
    ),
    webDir: str('WEB_DIR', resolve(process.cwd(), 'web', 'dist')),
  };
  return cfg;
}


