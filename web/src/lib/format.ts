export function formatDate(value: string | Date | null | undefined, withTime = false): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (!withTime) return `${y}-${m}-${d}`;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return '—';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(date);
}

export function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export const KIND_LABEL: Record<string, string> = {
  entity: '实体',
  intent: '意图',
  concept: '概念',
  '实体': '实体',
  '意图': '意图',
  '概念': '概念',
};

export const KIND_COLOR: Record<string, string> = {
  entity: 'var(--color-chart-1)',
  intent: 'var(--color-chart-2)',
  concept: 'var(--color-chart-3)',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export const INTENTS = ['查状态', '求推荐', '排错', '决策', '学习', '信息同步', '情感交流'] as const;

export const LABEL_TEXT: Record<string, { title: string; hint: string }> = {
  persona: { title: '性格与表达', hint: '稳定的表达风格与偏好，人工维护' },
  rules: { title: '硬规则', hint: '只允许人工修改，系统与模型不得写入' },
  skills: { title: '经验（一句话描述 + 详细描述）', hint: 'L1 只注入热度前 5 条索引，详细描述按 id 取用' },
};
