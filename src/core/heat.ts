const LN2 = Math.log(2);
const DAY_MS = 86_400_000;

/**
 * 热度指数衰减（FR-14）。
 * 增量更新：只在访问事件发生时按"距上次更新的时长"折算，不做定时全表刷新（NFR-09）。
 */
export function decayedValue(value: number, halfLifeDays: number, elapsedMs: number): number {
  if (value <= 0) return 0;
  if (elapsedMs <= 0) return value;
  const hl = Math.max(halfLifeDays, 1e-6);
  return value * Math.exp((-LN2 * elapsedMs) / DAY_MS / hl);
}

export function projectHeat(
  value: number,
  updatedAt: Date,
  halfLifeDays: number,
  now: Date,
): number {
  return decayedValue(value, halfLifeDays, now.getTime() - updatedAt.getTime());
}

/** 访问信号累加：先衰减到当前，再叠加本次增量。 */
export function applyHeat(
  value: number,
  updatedAt: Date,
  halfLifeDays: number,
  delta: number,
  now: Date,
): { heat: number; heatAt: Date } {
  const current = projectHeat(value, updatedAt, halfLifeDays, now);
  return { heat: Math.max(0, current + delta), heatAt: now };
}

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}
