export interface MetricsSnapshot {
  recall: {
    count: number;
    avg_budget_used: number;
    max_budget_used: number;
    avg_budget_utilization: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    hit_cards: number;
    dropped: number;
  };
  write: { events: number; condensed: number; condensed_new: number; appended: number; condense_failed: number };
  uptime_ms: number;
}

interface State {
  recallCount: number;
  budgetUsedSum: number;
  budgetUsedMax: number;
  budgetLimitSum: number;
  hitCards: number;
  dropped: number;
  latencies: number[];
  events: number;
  condensed: number;
  condensedNew: number;
  appended: number;
  condenseFailed: number;
  startedAt: number;
}

const state: State = {
  recallCount: 0,
  budgetUsedSum: 0,
  budgetUsedMax: 0,
  budgetLimitSum: 0,
  hitCards: 0,
  dropped: 0,
  latencies: [],
  events: 0,
  condensed: 0,
  condensedNew: 0,
  appended: 0,
  condenseFailed: 0,
  startedAt: Date.now(),
};

export function recordRecall(input: {
  budgetUsed: number;
  budgetLimit: number;
  hitCards: number;
  dropped: number;
  latencyMs: number;
}): void {
  state.recallCount += 1;
  state.budgetUsedSum += input.budgetUsed;
  state.budgetUsedMax = Math.max(state.budgetUsedMax, input.budgetUsed);
  state.budgetLimitSum += input.budgetLimit;
  state.hitCards += input.hitCards;
  state.dropped += input.dropped;
  state.latencies.push(input.latencyMs);
  if (state.latencies.length > 1000) state.latencies.shift();
}

export function recordEvent(condensed: boolean, failed = false, appended = false): void {
  state.events += 1;
  if (condensed) state.condensed += 1;
  if (condensed) {
    if (appended) state.appended += 1;
    else state.condensedNew += 1;
  }
  if (failed) state.condenseFailed += 1;
}

export function metricsSnapshot(): MetricsSnapshot {
  const n = state.recallCount || 1;
  const sorted = [...state.latencies].sort((a, b) => a - b);
  const p95 = sorted.length > 0 ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number) : 0;
  const avgLatency = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  return {
    recall: {
      count: state.recallCount,
      avg_budget_used: round(state.budgetUsedSum / n),
      max_budget_used: round(state.budgetUsedMax),
      avg_budget_utilization: round(state.budgetLimitSum > 0 ? state.budgetUsedSum / state.budgetLimitSum : 0),
      avg_latency_ms: round(avgLatency),
      p95_latency_ms: round(p95),
      hit_cards: state.hitCards,
      dropped: state.dropped,
    },
    write: {
      events: state.events,
      condensed: state.condensed,
      condensed_new: state.condensedNew,
      appended: state.appended,
      condense_failed: state.condenseFailed,
    },
    uptime_ms: Date.now() - state.startedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
