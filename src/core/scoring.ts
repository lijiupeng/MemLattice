import { daysBetween } from './heat.js';

/** 5.3 打分公式权重。频次项用热度替代 use_count（FR-14：计数信号只认行为）。 */
export const SCORE_WEIGHTS = {
  ppr: 0.45,
  recency: 0.25,
  heat: 0.15,
  importance: 0.15,
} as const;

/** 强关联条件（三条同时满足），否则只出提示行。 */
export const STRONG_RULES = {
  minPpr: 0.3,
  maxAgeDays: 30,
  minOverlap: 2,
} as const;

export function heatNorm(heat: number): number {
  const ceiling = Math.log1p(10);
  return Math.min(1, Math.log1p(Math.max(0, heat)) / ceiling);
}

export function recency(ageDays: number, halfLifeDays = 30): number {
  if (!Number.isFinite(ageDays)) return 0;
  return Math.exp((-Math.LN2 * Math.max(0, ageDays)) / halfLifeDays);
}

export interface CardScoreInput {
  pprNorm: number;
  ageDays: number;
  heat: number;
  importance: number;
}

export function cardScore(input: CardScoreInput): number {
  const score =
    SCORE_WEIGHTS.ppr * Math.max(0, Math.min(1, input.pprNorm)) +
    SCORE_WEIGHTS.recency * recency(input.ageDays) +
    SCORE_WEIGHTS.heat * heatNorm(input.heat) +
    SCORE_WEIGHTS.importance * Math.max(0, Math.min(1, input.importance));
  return Math.round(score * 1e6) / 1e6;
}

export function isStrong(args: {
  pprNorm: number;
  ageDays: number;
  overlap: number;
}): boolean {
  return (
    args.pprNorm >= STRONG_RULES.minPpr &&
    args.ageDays <= STRONG_RULES.maxAgeDays &&
    args.overlap >= STRONG_RULES.minOverlap
  );
}

/**
 * 采用率折减：曝光多、采用少的卡是噪声，保留但不再挤占预算。
 * 曝光不足 5 次样本太小，不折减；最低折到 0.6 倍，避免一次性判死。
 */
export function precisionFactor(useCount: number, hitCount: number): number {
  if (hitCount < 5) return 1;
  const precision = Math.max(0, Math.min(1, useCount / hitCount));
  return 0.6 + 0.4 * precision;
}

/** FR-16 冷判定：热度 <0.5 且连续 90 天未被命中/召回。 */
export function isCold(args: {
  heat: number;
  lastTouchedAt: Date;
  now: Date;
  coldHeatThreshold: number;
  coldIdleDays: number;
}): boolean {
  return (
    args.heat < args.coldHeatThreshold &&
    daysBetween(args.lastTouchedAt, args.now) >= args.coldIdleDays
  );
}
