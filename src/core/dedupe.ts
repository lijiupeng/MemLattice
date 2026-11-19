import { diceSimilarity, normalize } from './text.js';

/**
 * 事件卡重复判定：同一会话持续做一件事时，新事件应追加到已有卡，而不是新建。
 * 纯函数，便于单测与调参；不做任何 IO。
 */

export interface DedupeCandidate {
  id: number;
  summary: string;
  keywords: readonly string[];
  intent: string | null;
  /** 候选卡所属事件与本事件是否同一 session_id */
  sameSession: boolean;
  version?: number;
  heat?: number;
}

export interface DedupeIncoming {
  summary: string;
  keywords: readonly string[];
  intent: string | null;
}

export interface DedupeDecision {
  append: boolean;
  score: number;
  sharedKeywords: string[];
  reason: string;
}

/** 跨会话合并阈值（同会话走"≥2 词重合"的硬规则，不依赖阈值） */
export const DEDUPE_THRESHOLD = 0.55;

function keywordSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => normalize(value)).filter((value) => value.length > 0));
}

export function decideAppend(candidate: DedupeCandidate, incoming: DedupeIncoming): DedupeDecision {
  const a = keywordSet(candidate.keywords);
  const b = keywordSet(incoming.keywords);
  const union = new Set([...a, ...b]);
  const shared = [...a].filter((word) => b.has(word));
  const jaccard = union.size > 0 ? shared.length / union.size : 0;
  const summaryDice = diceSimilarity(candidate.summary, incoming.summary);
  const sameSession = candidate.sameSession;

  const score = Math.min(1, 0.65 * jaccard + 0.35 * summaryDice + (sameSession ? 0.05 : 0));

  // 意图冲突视为不同主题（两边都标了意图且不一致）
  const intentConflict =
    Boolean(candidate.intent) && Boolean(incoming.intent) && candidate.intent !== incoming.intent;
  if (intentConflict) {
    return { append: false, score, sharedKeywords: shared, reason: '意图不同' };
  }

  // 同会话：共享 ≥2 个词且意图不冲突，视为"仍在做同一件事"，直接追加
  if (sameSession && shared.length >= 2) {
    return {
      append: true,
      score,
      sharedKeywords: shared,
      reason: `同会话同主题（${shared.length} 词重合）`,
    };
  }

  // 跨会话：要求共享 ≥2 个词且综合分达阈
  if (shared.length < 2) {
    return { append: false, score, sharedKeywords: shared, reason: `共享词不足（${shared.length}）` };
  }
  if (score < DEDUPE_THRESHOLD) {
    return { append: false, score, sharedKeywords: shared, reason: `相似度不足（${score.toFixed(2)}）` };
  }

  return {
    append: true,
    score,
    sharedKeywords: shared,
    reason: `近期同主题（${shared.length} 词重合，${score.toFixed(2)}）`,
  };
}

/** 在候选中挑相似度最高且达阈的一张卡；无候选则返回 null。 */
export function pickAppendTarget(
  candidates: readonly DedupeCandidate[],
  incoming: DedupeIncoming,
): { candidate: DedupeCandidate; decision: DedupeDecision } | null {
  let best: { candidate: DedupeCandidate; decision: DedupeDecision } | null = null;
  for (const candidate of candidates) {
    const decision = decideAppend(candidate, incoming);
    if (!decision.append) continue;
    if (!best || decision.score > best.decision.score) best = { candidate, decision };
  }
  return best;
}

const APPEND_MARK = '｜追加：';

function clampChars(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit <= 1) return '…';
  return `${chars.slice(0, limit - 1).join('')}…`;
}

/**
 * 摘要滚动合并：原始结论 + 最新一次追加，整体不超过 limit（默认 200，与建卡上限一致）。
 * 历史细节留在 L3 与版本快照里，摘要不做无限拼接。
 */
export function mergeSummary(existing: string, incoming: string, limit = 200): string {
  const base = (existing ?? '').trim();
  const extra = (incoming ?? '').trim();
  if (!base) return clampChars(extra, limit);
  if (!extra) return clampChars(base, limit);
  if (base.includes(extra)) return clampChars(base, limit);

  const parts = base.split(APPEND_MARK);
  const rawHead = parts[0] ?? base;
  const headCap = Math.max(40, Math.floor(limit * 0.45));
  const head = clampChars(rawHead, headCap);

  const room = limit - [...head].length - APPEND_MARK.length;
  if (room < 16) return head;
  return `${head}${APPEND_MARK}${clampChars(extra, room)}`;
}
