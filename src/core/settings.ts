import type { AppConfig } from '../config.js';
import { AppError } from './errors.js';

export type SettingValue = number | boolean | string[];

export type SettingGroupKey = 'budget' | 'life' | 'write' | 'blocks' | 'worker';

export interface SettingGroup {
  key: SettingGroupKey;
  title: string;
  description: string;
}

export interface SettingSpec {
  /** AppConfig 上的点路径，如 life.cardHalfLifeDays */
  key: string;
  /** 对应的环境变量名：仅作初始默认值与排查线索 */
  env: string;
  group: SettingGroupKey;
  label: string;
  hint: string;
  type: 'number' | 'boolean' | 'labels';
  unit?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
  /** 保存后仍要重启进程才完全生效 */
  restart?: boolean;
  options?: readonly string[];
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    key: 'budget',
    title: '检索预算',
    description: '一次 recall 能注入多少 token，以及弱关联提示的条数上限',
  },
  {
    key: 'life',
    title: '淡忘与生命周期',
    description: '热度衰减、冷却、骨架化、归档与清除的时间线；每日巡检按这里执行',
  },
  {
    key: 'write',
    title: '写入与成卡',
    description: '多轮攒批成卡的阈值，以及未成卡事件的收口方式',
  },
  {
    key: 'blocks',
    title: '常驻层审核',
    description: '哪些常驻块的模型写入需要人工确认后才生效',
  },
  {
    key: 'worker',
    title: '自动巡检',
    description: '每日巡检的开关与触发时刻；改动后重启生效',
  },
];

export const SETTING_SPECS: readonly SettingSpec[] = [
  {
    key: 'budget.defaultTokens',
    env: 'DEFAULT_BUDGET_TOKENS',
    group: 'budget',
    label: '默认检索预算',
    hint: '调用方不传 budget_tokens 时使用；不得超过预算上限',
    type: 'number',
    unit: 'tokens',
    min: 200,
    max: 32_000,
    integer: true,
  },
  {
    key: 'budget.maxTokens',
    env: 'MAX_BUDGET_TOKENS',
    group: 'budget',
    label: '预算硬上限',
    hint: '超过这个值直接拒绝，保证注入量永远有界',
    type: 'number',
    unit: 'tokens',
    min: 200,
    max: 64_000,
    integer: true,
  },
  {
    key: 'budget.weakHintLimit',
    env: 'WEAK_HINT_LIMIT',
    group: 'budget',
    label: '弱关联提示条数',
    hint: '只出一行提示、不占预算；0 表示不提示',
    type: 'number',
    unit: '条',
    min: 0,
    max: 20,
    integer: true,
  },

  {
    key: 'life.termHalfLifeDays',
    env: 'TERM_HALF_LIFE_DAYS',
    group: 'life',
    label: '关键词热度半衰期',
    hint: '关键词热度每过这么多天衰减一半',
    type: 'number',
    unit: '天',
    min: 1,
    max: 3650,
    integer: true,
  },
  {
    key: 'life.cardHalfLifeDays',
    env: 'CARD_HALF_LIFE_DAYS',
    group: 'life',
    label: '卡片热度半衰期',
    hint: '越大越"念旧"，旧记忆在排序里保留得越久',
    type: 'number',
    unit: '天',
    min: 1,
    max: 3650,
    integer: true,
  },
  {
    key: 'life.coldHeat',
    env: 'COLD_HEAT_THRESHOLD',
    group: 'life',
    label: '冷记忆热度阈值',
    hint: '热度低于它且久未命中，就不再出现在默认检索结果里',
    type: 'number',
    min: 0,
    max: 20,
    step: 0.1,
  },
  {
    key: 'life.coldDays',
    env: 'COLD_IDLE_DAYS',
    group: 'life',
    label: '冷记忆闲置天数',
    hint: '连续这么多天没被命中，才算冷记忆',
    type: 'number',
    unit: '天',
    min: 1,
    max: 3650,
    integer: true,
  },
  {
    key: 'life.skeletonMaxChars',
    env: 'SKELETON_MAX_CHARS',
    group: 'life',
    label: '骨架卡摘要上限',
    hint: '冷卡压成骨架卡后保留的最大字数，原文引用会被断开',
    type: 'number',
    unit: '字',
    min: 10,
    max: 1000,
    integer: true,
  },
  {
    key: 'life.keepHistoryRatio',
    env: 'KEEP_HISTORY_CARD_RATIO',
    group: 'life',
    label: '每年保底保留比例',
    hint: '骨架化时至少留下这么大比例的卡，避免记忆被清空',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'life.l1IdleDemoteDays',
    env: 'L1_IDLE_DEMOTE_DAYS',
    group: 'life',
    label: '常驻块闲置降级天数',
    hint: '常驻条目这么久没被用到就降级回事件卡',
    type: 'number',
    unit: '天',
    min: 1,
    max: 3650,
    integer: true,
  },
  {
    key: 'life.skillMaxChars',
    env: 'SKILL_MAX_CHARS',
    group: 'life',
    label: '经验索引单行上限',
    hint: '经验的一句话描述长度，它决定 L1 索引占多少预算',
    type: 'number',
    unit: '字',
    min: 10,
    max: 200,
    integer: true,
  },
  {
    key: 'life.skillDetailMaxChars',
    env: 'SKILL_DETAIL_MAX_CHARS',
    group: 'life',
    label: '经验正文上限',
    hint: '下钻取回的经验详细描述最大字数',
    type: 'number',
    unit: '字',
    min: 200,
    max: 20_000,
    integer: true,
  },
  {
    key: 'life.skillIndexLimit',
    env: 'SKILL_INDEX_LIMIT',
    group: 'life',
    label: '注入的经验条数',
    hint: '只按热度取前 N 条索引进常驻层，正文按需下钻',
    type: 'number',
    unit: '条',
    min: 0,
    max: 30,
    integer: true,
  },
  {
    key: 'life.skillL1MaxTokens',
    env: 'SKILL_L1_MAX_TOKENS',
    group: 'life',
    label: '经验索引预算',
    hint: '常驻层里经验索引行（不含正文）的 token 上限，超了少列几条，不动已存的经验',
    type: 'number',
    unit: 'tokens',
    min: 50,
    max: 4000,
    integer: true,
  },
  {
    key: 'life.rawArchiveDays',
    env: 'RAW_ARCHIVE_AFTER_DAYS',
    group: 'life',
    label: '原文归档天数',
    hint: 'L3 原文超过这么久标记归档，不再参与默认回看',
    type: 'number',
    unit: '天',
    min: 1,
    max: 3650,
    integer: true,
  },
  {
    key: 'life.rawPurgeDays',
    env: 'RAW_PURGE_AFTER_DAYS',
    group: 'life',
    label: '原文清除天数',
    hint: '归档满这么久进回收站，再过期才真正删除；不得小于归档天数',
    type: 'number',
    unit: '天',
    min: 1,
    max: 7300,
    integer: true,
  },
  {
    key: 'life.trashRestoreDays',
    env: 'TRASH_RESTORE_DAYS',
    group: 'life',
    label: '回收站保留天数',
    hint: '软删后还能恢复的窗口，到期才物理清除',
    type: 'number',
    unit: '天',
    min: 1,
    max: 365,
    integer: true,
  },
  {
    key: 'life.recentLimit',
    env: 'RECENT_INDEX_LIMIT',
    group: 'life',
    label: '滚动索引条数',
    hint: '检索时附带最近事件的数量；0 表示不附带',
    type: 'number',
    unit: '条',
    min: 0,
    max: 100,
    integer: true,
  },
  {
    key: 'life.recentTtlDays',
    env: 'RECENT_INDEX_TTL_DAYS',
    group: 'life',
    label: '滚动索引有效期',
    hint: '超过这么多天的事件不再进滚动索引',
    type: 'number',
    unit: '天',
    min: 1,
    max: 365,
    integer: true,
  },

  {
    key: 'write.condenseTurnThreshold',
    env: 'CONDENSE_TURN_THRESHOLD',
    group: 'write',
    label: '攒批成卡轮数',
    hint: '同一事件攒到这么多轮就自动浓缩成卡',
    type: 'number',
    unit: '轮',
    min: 1,
    max: 200,
    integer: true,
  },
  {
    key: 'write.condenseMaxAttempts',
    env: 'CONDENSE_MAX_ATTEMPTS',
    group: 'write',
    label: '浓缩重试次数',
    hint: '失败后指数退避重试，超过次数转人工队列',
    type: 'number',
    unit: '次',
    min: 1,
    max: 20,
    integer: true,
  },
  {
    key: 'write.autoResumeMinutes',
    env: 'WRITE_AUTO_RESUME_MINUTES',
    group: 'write',
    label: '自动续写窗口',
    hint: '不传 event_id 时，复用窗口内最近一条未成卡事件；0 关闭',
    type: 'number',
    unit: '分钟',
    min: 0,
    max: 1440,
    integer: true,
  },
  {
    key: 'write.openEventSweepHours',
    env: 'OPEN_EVENT_SWEEP_HOURS',
    group: 'write',
    label: '未成卡收口时长',
    hint: '巡检把超过这么久还没成卡的事件强制收口；0 关闭',
    type: 'number',
    unit: '小时',
    min: 0,
    max: 168,
    integer: true,
  },

  {
    key: 'blocks.approvalLabels',
    env: 'BLOCK_APPROVAL_LABELS',
    group: 'blocks',
    label: '需要人工审核的块',
    hint: '选中的块，模型写入会进待审队列；都不选表示全部直写',
    type: 'labels',
    options: ['rules', 'persona', 'skills'],
  },

  {
    key: 'worker.enabled',
    env: 'WORKER_ENABLED',
    group: 'worker',
    label: '启用每日巡检',
    hint: '关闭后淡忘、归档、回收站清理都不会自动执行',
    type: 'boolean',
    restart: true,
  },
  {
    key: 'worker.hour',
    env: 'WORKER_HOUR',
    group: 'worker',
    label: '巡检触发时刻',
    hint: '本地时区的整点；改动在下次重启后按新时刻排程',
    type: 'number',
    unit: '点',
    min: 0,
    max: 23,
    integer: true,
    restart: true,
  },
];

export const SETTING_INDEX: ReadonlyMap<string, SettingSpec> = new Map(
  SETTING_SPECS.map((spec) => [spec.key, spec]),
);

function bag(cfg: AppConfig, key: string): Record<string, SettingValue> {
  const group = key.split('.')[0] as SettingGroupKey;
  const target = cfg[group] as unknown as Record<string, SettingValue> | undefined;
  if (!target || typeof target !== 'object') {
    throw new AppError('E_INVALID', `未知参数 ${key}`);
  }
  return target;
}

export function readSetting(cfg: AppConfig, key: string): SettingValue {
  const field = key.split('.')[1] as string;
  const target = bag(cfg, key);
  const value = target[field];
  if (value === undefined) throw new AppError('E_INVALID', `未知参数 ${key}`);
  return value;
}

export function writeSetting(cfg: AppConfig, key: string, value: SettingValue): void {
  const field = key.split('.')[1] as string;
  const target = bag(cfg, key);
  if (target[field] === undefined) throw new AppError('E_INVALID', `未知参数 ${key}`);
  target[field] = value;
}

export function collectSettings(cfg: AppConfig): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const spec of SETTING_SPECS) out[spec.key] = readSetting(cfg, spec.key);
  return out;
}

export function normalizeSetting(spec: SettingSpec, raw: unknown): SettingValue {
  if (spec.type === 'number') {
    const raw_ = typeof raw === 'string' ? raw.trim() : raw;
    if (raw_ === '' || raw_ === null || raw_ === undefined) {
      throw new AppError('E_INVALID', `${spec.label} 不能为空`);
    }
    const parsed = Number(raw_);
    if (!Number.isFinite(parsed)) {
      throw new AppError('E_INVALID', `${spec.label} 必须是数字`);
    }
    const value = spec.integer ? Math.round(parsed) : parsed;
    if (spec.min !== undefined && value < spec.min) {
      throw new AppError('E_INVALID', `${spec.label} 不得小于 ${spec.min}`);
    }
    if (spec.max !== undefined && value > spec.max) {
      throw new AppError('E_INVALID', `${spec.label} 不得大于 ${spec.max}`);
    }
    return value;
  }

  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 1 || raw === '1' || raw === 'true') return true;
    if (raw === 0 || raw === '0' || raw === 'false') return false;
    throw new AppError('E_INVALID', `${spec.label} 只能是开或关`);
  }

  const allowed = spec.options ?? [];
  const items = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const picked: string[] = [];
  for (const item of items) {
    const value = String(item).trim().toLowerCase();
    if (!value) continue;
    if (!allowed.includes(value)) {
      throw new AppError('E_INVALID', `${spec.label} 只能取 ${allowed.join(' / ')}`);
    }
    if (!picked.includes(value)) picked.push(value);
  }
  return picked;
}

/** 跨字段约束：单值校验通过后仍可能互相矛盾，这里统一兜住。 */
export function checkSettingConsistency(values: Record<string, SettingValue>): void {
  const num = (key: string): number => Number(values[key]);
  if (num('budget.defaultTokens') > num('budget.maxTokens')) {
    throw new AppError('E_INVALID', '默认检索预算不能大于预算硬上限');
  }
  if (num('life.rawPurgeDays') < num('life.rawArchiveDays')) {
    throw new AppError('E_INVALID', '原文清除天数不能小于归档天数');
  }
}
