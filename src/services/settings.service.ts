import { loadConfig } from '../config.js';
import { AppError } from '../core/errors.js';
import {
  SETTING_GROUPS,
  SETTING_INDEX,
  SETTING_SPECS,
  checkSettingConsistency,
  collectSettings,
  normalizeSetting,
  readSetting,
  writeSetting,
  type SettingGroup,
  type SettingSpec,
  type SettingValue,
} from '../core/settings.js';
import { getUserId, writeAudit, type Ctx } from './context.js';

export interface SettingEntry extends SettingSpec {
  value: SettingValue;
  default: SettingValue;
  /** db=页面改过；env=来自环境变量；default=代码默认值 */
  source: 'db' | 'env' | 'default';
}

export interface SettingsPayload {
  groups: readonly SettingGroup[];
  entries: SettingEntry[];
  service: Array<{ label: string; value: string; hint: string }>;
  updated_at: string | null;
  /** 本次保存里有需要重启才完全生效的项 */
  restart_pending: boolean;
}

/** 首次加载时的配置快照，作为"默认值"的展示基准，避免与 config.ts 各写一份默认值。 */
let baseline: Record<string, SettingValue> | null = null;

function maskToken(token: string): string {
  if (!token) return '未设置';
  if (token.length <= 6) return '•'.repeat(token.length);
  return `${token.slice(0, 2)}••••${token.slice(-2)}（${token.length} 位）`;
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const auth = parsed.username ? `${parsed.username}:••••@` : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//••••@');
  }
}

function defaults(): Record<string, SettingValue> {
  return baseline ?? {};
}

/** 启动时把库里的覆盖值写回内存配置；返回被覆盖的键。 */
export async function loadSettings(ctx: Ctx): Promise<string[]> {
  if (baseline === null) baseline = collectSettings(ctx.cfg);
  const userId = await getUserId(ctx);
  const rows = await ctx.sql<Array<{ key: string; value: string }>>`
    SELECT key, value FROM app_setting WHERE user_id = ${userId}`;

  const applied: string[] = [];
  for (const row of rows) {
    const spec = SETTING_INDEX.get(row.key);
    if (!spec) continue;
    try {
      const value = normalizeSetting(spec, JSON.parse(row.value));
      writeSetting(ctx.cfg, row.key, value);
      applied.push(row.key);
    } catch {
      // 历史值可能已超出当前范围：保留内存里的默认值，不阻断启动
    }
  }
  return applied;
}

export async function listSettings(ctx: Ctx): Promise<SettingsPayload> {
  const userId = await getUserId(ctx);
  const rows = await ctx.sql<Array<{ key: string; value: string; updated_at: string }>>`
    SELECT key, value, updated_at FROM app_setting WHERE user_id = ${userId}`;
  const stored = new Map(rows.map((row) => [row.key, row]));

  const entries: SettingEntry[] = SETTING_SPECS.map((spec) => {
    const hit = stored.get(spec.key);
    const source: SettingEntry['source'] = hit
      ? 'db'
      : process.env[spec.env] === undefined || process.env[spec.env] === ''
        ? 'default'
        : 'env';
    return {
      ...spec,
      value: readSetting(ctx.cfg, spec.key),
      default: defaults()[spec.key] ?? readSetting(ctx.cfg, spec.key),
      source,
    };
  });

  const latest = rows.reduce<string | null>(
    (acc, row) => (acc === null || row.updated_at > acc ? row.updated_at : acc),
    null,
  );

  return {
    groups: SETTING_GROUPS,
    entries,
    service: [
      { label: '监听地址', value: `${ctx.cfg.host}:${ctx.cfg.port}`, hint: '改端口或网卡需改部署配置' },
      { label: '访问令牌', value: maskToken(ctx.cfg.authToken), hint: 'MEMLATTICE_TOKEN' },
      { label: '数据库', value: maskUrl(ctx.cfg.databaseUrl), hint: 'DATABASE_URL' },
      { label: '日志级别', value: ctx.cfg.logLevel, hint: 'LOG_LEVEL' },
      {
        label: '允许来源',
        value: ctx.cfg.allowedOrigins.length > 0 ? ctx.cfg.allowedOrigins.join(' · ') : '仅同源',
        hint: 'ALLOWED_ORIGINS',
      },
      {
        label: '默认用户',
        value: `${ctx.cfg.user.displayName}（${ctx.cfg.user.externalId}）`,
        hint: 'DEFAULT_USER_EXTERNAL_ID',
      },
    ],
    updated_at: latest,
    restart_pending: false,
  };
}

export async function updateSettings(
  ctx: Ctx,
  raw: unknown,
  actor: 'human' | 'agent' = 'human',
): Promise<{ changed: string[]; restart_pending: boolean }> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('E_INVALID', 'values 必须是对象');
  }
  const patch = raw as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new AppError('E_INVALID', '没有要保存的参数');

  const next = new Map<string, SettingValue>();
  for (const key of keys) {
    const spec = SETTING_INDEX.get(key);
    if (!spec) throw new AppError('E_INVALID', `未知参数 ${key}`);
    next.set(key, normalizeSetting(spec, patch[key]));
  }

  const before: Record<string, SettingValue> = {};
  const after: Record<string, SettingValue> = {};
  const merged = collectSettings(ctx.cfg);
  for (const [key, value] of next) {
    before[key] = readSetting(ctx.cfg, key);
    merged[key] = value;
    after[key] = value;
  }
  checkSettingConsistency(merged);

  const userId = await getUserId(ctx);
  for (const [key, value] of next) {
    const serialized = JSON.stringify(value);
    await ctx.sql`
      INSERT INTO app_setting (user_id, key, value, updated_by)
      VALUES (${userId}, ${key}, ${serialized}, ${actor})
      ON CONFLICT (user_id, key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = ${ctx.now()}`;
    writeSetting(ctx.cfg, key, value);
  }

  await writeAudit(ctx, {
    userId,
    objectType: 'setting',
    objectId: 0,
    op: 'update',
    before,
    after,
    actor,
    reason: '页面调整运行时参数',
  });

  return {
    changed: keys,
    restart_pending: keys.some((key) => SETTING_INDEX.get(key)?.restart === true),
  };
}

export async function resetSetting(
  ctx: Ctx,
  key: string,
  actor: 'human' | 'agent' = 'human',
): Promise<{ key: string; value: SettingValue }> {
  const spec = SETTING_INDEX.get(key);
  if (!spec) throw new AppError('E_INVALID', `未知参数 ${key}`);

  const userId = await getUserId(ctx);
  const before = readSetting(ctx.cfg, key);
  const value = readSetting(loadConfig(), key);

  await ctx.sql`DELETE FROM app_setting WHERE user_id = ${userId} AND key = ${key}`;
  writeSetting(ctx.cfg, key, value);

  await writeAudit(ctx, {
    userId,
    objectType: 'setting',
    objectId: 0,
    op: 'reset',
    before: { [key]: before },
    after: { [key]: value },
    actor,
    reason: '恢复为环境变量/默认值',
  });

  return { key, value };
}
