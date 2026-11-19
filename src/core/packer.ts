import { estimateTokens, trimToTokens } from './tokens.js';

export type PackKind = 'block' | 'recent-index' | 'card';

export interface PackItem {
  /** 唯一键，如 block:rules / card:12 */
  key: string;
  kind: PackKind;
  /** 注入层级，越小越先装填 */
  tier: number;
  /** 同类内按性价比（score/token）排序 */
  score: number;
  text: string;
  tokens: number;
  /** 允许在剩余预算内截断（默认整块保留或整块丢弃） */
  truncatable?: boolean;
  /** 实际发生了截断 */
  truncated?: boolean;
  /** 记录用途，回传给调用方便于审计 */
  meta?: Record<string, unknown>;
}

export interface PackDropped {
  key: string;
  kind: PackKind;
  tokens: number;
  reason: 'budget' | 'truncated-to-zero';
  meta?: Record<string, unknown>;
}

export interface PackResult {
  included: PackItem[];
  dropped: PackDropped[];
  used: number;
  budget: number;
}

export function makePackItem(
  input: Omit<PackItem, 'tokens'> & { tokens?: number },
): PackItem {
  return { ...input, tokens: input.tokens ?? estimateTokens(input.text) };
}

/**
 * 预算硬约束（FR-07）：按 score/token 贪心装填，装不下就停在预算处，
 * 并记录 dropped 明细。任何注入上下文的路径都必须经过这里。
 */
export function pack(items: readonly PackItem[], budget: number): PackResult {
  const ordered = [...items].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const da = a.tokens > 0 ? a.score / a.tokens : a.score;
    const db = b.tokens > 0 ? b.score / b.tokens : b.score;
    if (db !== da) return db - da;
    return a.key.localeCompare(b.key);
  });

  const included: PackItem[] = [];
  const dropped: PackDropped[] = [];
  let used = 0;

  for (const item of ordered) {
    const remaining = budget - used;
    if (item.tokens <= remaining) {
      included.push(item);
      used += item.tokens;
      continue;
    }
    if (item.truncatable && remaining > 0) {
      // 只在句末/分隔符处截断；找不到边界就整块丢弃，避免切出半句
      const text = trimAtBoundary(item.text, remaining);
      const tokens = estimateTokens(text);
      if (tokens > 0 && text.trim().length > 0) {
        included.push({ ...item, text, tokens, truncated: true });
        used += tokens;
        dropped.push({
          key: item.key,
          kind: item.kind,
          tokens: item.tokens - tokens,
          reason: 'budget',
          meta: { ...item.meta, truncated: true },
        });
        continue;
      }
    }
    dropped.push({
      key: item.key,
      kind: item.kind,
      tokens: item.tokens,
      reason: 'budget',
      meta: item.meta,
    });
  }

  return { included, dropped, used, budget };
}

const BOUNDARY = /[。！？；!?;\n]/;

/** 截到 maxTokens 且落在句末边界；找不到合适边界时返回空串（调用方按丢弃处理）。 */
function trimAtBoundary(text: string, maxTokens: number): string {
  const cut = trimToTokens(text, maxTokens);
  if (cut.length >= text.length) return text;
  const floor = Math.max(1, Math.floor(cut.length * 0.6));
  for (let i = cut.length; i > floor; i -= 1) {
    if (BOUNDARY.test(cut[i - 1] ?? '')) return cut.slice(0, i);
  }
  return '';
}
