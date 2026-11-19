/**
 * 同义扩展（term_edge.type = 'alias'）。
 *
 * 只解决"知道该搜哪个词、但说法不一样"这一类问题：同义边把另一个词带进 PPR，
 * 但三层降权保证它压不过真实共现——写边低权、seed fan-out 打折、进 PPR 再乘系数。
 */
export const ALIAS_LINK = {
  /** 写边时的初始权重；冲突时取 GREATEST，不随重复写入累加 */
  edgeWeight: 0.4,
  /** 进入 PPR 时的额外衰减（co_occur 等其它类型为 1） */
  edgeFactor: 0.5,
  /** fan-out 出的同义种子权重 = 源种子权重 × 该系数 */
  seedDecay: 0.6,
  /** 每条种子最多 fan-out 几个同义词，防止同义簇把种子铺满 */
  maxNeighbors: 3,
} as const;

export interface AliasNeighbor {
  /** 已命中的种子词 */
  srcId: number;
  /** 同义邻居 */
  dstId: number;
  name: string;
}

export interface AliasSeedExpansion {
  weights: Map<number, number>;
  added: Array<{ id: number; name: string }>;
}

/**
 * 对种子做一跳 alias fan-out。已在种子里的词不覆盖（保留词典命中的原始权重），
 * 每条源种子最多扩 maxNeighbors 个，结果按源种子权重打折。
 */
export function expandAliasSeeds(
  weights: ReadonlyMap<number, number>,
  neighbors: readonly AliasNeighbor[],
  options: { decay?: number; maxNeighbors?: number } = {},
): AliasSeedExpansion {
  const decay = options.decay ?? ALIAS_LINK.seedDecay;
  const maxNeighbors = options.maxNeighbors ?? ALIAS_LINK.maxNeighbors;
  const next = new Map(weights);
  const added: Array<{ id: number; name: string }> = [];
  const seen = new Set<number>();
  const perSource = new Map<number, number>();

  for (const neighbor of neighbors) {
    const { srcId, dstId } = neighbor;
    if (srcId === dstId) continue;
    // 已经是种子：不覆盖，也不重复计入
    if (next.has(dstId) || seen.has(dstId)) continue;
    const used = perSource.get(srcId) ?? 0;
    if (used >= maxNeighbors) continue;
    const base = next.get(srcId);
    if (base === undefined || !(base > 0)) continue;
    perSource.set(srcId, used + 1);
    seen.add(dstId);
    next.set(dstId, base * decay);
    added.push({ id: dstId, name: neighbor.name });
  }

  return { weights: next, added };
}
